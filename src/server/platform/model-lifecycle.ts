import { GlideRecord } from '@servicenow/glide'
import { EVENT } from '../domain/events.ts'
import { isNaasModel, naasModelCondition, OEM_PID_FIELD } from '../domain/fleet.ts'
import { createMarks } from '../domain/marks.ts'
import {
    backwardsMilestones,
    LIFECYCLE_SOURCE_LABEL,
    mergeLifecycle,
    MILESTONE_ROWS,
    MILESTONES,
    MODEL_LIFECYCLE,
    OWN_MILESTONE_ROWS,
    parseLifecycleRow,
    type LifecycleDates,
    type LifecycleSource,
} from '../domain/model-lifecycle.ts'
import { queueJob } from './events.ts'
import { loadNormalizationData, resolveModel } from './normalization.ts'
import { findById, refusal, rowError, str, type RowOutcome } from './records.ts'

/**
 * A Model's manufacturer support milestones, kept in the platform's Model lifecycle table (ADR 0017): one row per
 * Model and milestone, the milestone in `lifecycle_phase` and its date in `start_date`. Only this module reads and
 * writes the table, by the names domain/model-lifecycle gives it (`MODEL_LIFECYCLE`, `MILESTONES`); the rest of the app
 * works with `LifecycleDates`.
 *
 * The table is shared (ADR 0016): the Provider's IT keeps milestones of its own Models there, and a row whose `source`
 * is ServiceNow is one its content service supplies (Hardware Asset Management Professional, which the instance this
 * was read on does not have).
 *
 * The platform's rules on it (Model Management, Brazil instance, 2026-11-09; docs/research/external-contracts.md N40):
 * rows are of class `cmdb_model_lifecycle` or a child class per kind of Model, and `cmdb_hardware_model_lifecycle`
 * takes a hardware Model only; an insert without a start date is refused; so is a second active row for one Model,
 * lifecycle type, phase and source. This scope may read, create and update rows, not delete them.
 */

/** The description column's length. */
const DESCRIPTION_MAX_LENGTH = 1000

/** Where a milestone's date comes from: kept as one line in the row's description. */
interface LifecycleProvenance {
    source: LifecycleSource
    /** The bulletin or document the source gives the date in (a URL or an id), when it names one. */
    reference?: string
}

/** What a write did with the milestones it was given. */
interface LifecycleWrite {
    /** Milestones the Model had no row of the app's for. */
    inserted: number
    /** Milestones whose date or provenance changed. */
    updated: number
    /** Milestones stored as given already. */
    unchanged: number
    /** Why each milestone the platform refused was not saved. */
    refused: string[]
}

/** The Models whose milestones a write is saving, for the rule on the table to leave those saves to the write. */
const writing = createMarks<string>()

function milestoneOf(phase: string): keyof LifecycleDates | undefined {
    return MILESTONES.find((milestone) => milestone.phase === phase)?.field
}

/**
 * Read a Model's lifecycle milestones (none when no row gives one) from its active manufacturer rows of every source,
 * so one the Provider's IT keeps by hand or ServiceNow's content service supplies counts too. Where two rows give the
 * same milestone the app's own source wins; among the others, the row updated last.
 */
export function readModelLifecycle(modelId: string): LifecycleDates {
    if (!modelId) return {}
    const own: LifecycleDates = {}
    const others: LifecycleDates = {}
    const row = new GlideRecord(MODEL_LIFECYCLE.table)
    row.addQuery('model', modelId)
    row.addEncodedQuery(`${MILESTONE_ROWS}^start_dateISNOTEMPTY`)
    row.orderBy('sys_updated_on')
    row.query()
    while (row.next()) {
        const milestone = milestoneOf(str(row, 'lifecycle_phase'))
        if (!milestone) continue
        const dates = str(row, 'source') === MODEL_LIFECYCLE.ownSource ? own : others
        dates[milestone] = str(row, 'start_date')
    }
    return mergeLifecycle(others, own)
}

/**
 * Store the milestones a source gives for a Model, each on the app's row for it: created when the Model has none,
 * updated when its date or provenance differs, left alone when it is stored as given. A milestone the source does not
 * give keeps what is stored, and no row is ever removed (this scope may not delete them). A row the platform refuses is
 * reported in `refused`, and the other milestones are still saved.
 *
 * The recomputation of the Model's fleet assets is queued here, once, when a date changed: the rule on the table
 * (entry/models `onModelLifecycleChanged`) would queue it for each row saved.
 */
export function writeModelLifecycle(modelId: string, dates: LifecycleDates, provenance: LifecycleProvenance): LifecycleWrite {
    const result: LifecycleWrite = { inserted: 0, updated: 0, unchanged: 0, refused: [] }
    const pending = new Map<string, { date: string; label: string }>()
    for (const { field, phase, label } of MILESTONES) {
        const date = dates[field]
        if (date) pending.set(phase, { date, label })
    }
    if (!modelId || pending.size === 0) return result
    const description = provenanceLine(provenance)
    let dated = false
    const save = (row: GlideRecord, { date, label }: { date: string; label: string }, stored: boolean): void => {
        const moved = str(row, 'start_date') !== date
        row.setValue('start_date', date)
        row.setValue('description', description)
        if (!(stored ? row.update() : row.insert())) return void result.refused.push(`${label}: ${refusal(row)}`)
        if (stored) result.updated++
        else result.inserted++
        if (moved) dated = true
    }
    writing.during(modelId, () => {
        const stored = new GlideRecord(MODEL_LIFECYCLE.table)
        stored.addQuery('model', modelId)
        stored.addEncodedQuery(OWN_MILESTONE_ROWS)
        stored.query()
        while (stored.next()) {
            const phase = str(stored, 'lifecycle_phase')
            const milestone = pending.get(phase)
            if (milestone === undefined) continue
            pending.delete(phase)
            if (str(stored, 'start_date') === milestone.date && str(stored, 'description') === description) result.unchanged++
            else save(stored, milestone, true)
        }
        for (const [phase, milestone] of pending) {
            const fresh = new GlideRecord(MODEL_LIFECYCLE.hardwareTable)
            fresh.initialize()
            fresh.setValue('model', modelId)
            fresh.setValue('lifecycle_type', MODEL_LIFECYCLE.publisher)
            fresh.setValue('source', MODEL_LIFECYCLE.ownSource)
            fresh.setValue('lifecycle_phase', phase)
            fresh.setValue('active', true)
            save(fresh, milestone, false)
        }
    })
    if (dated) queueModelRefresh(modelId)
    return result
}

function provenanceLine(provenance: LifecycleProvenance): string {
    const label = LIFECYCLE_SOURCE_LABEL[provenance.source]
    const reference = (provenance.reference ?? '').trim()
    return (reference ? `${label}: ${reference}` : label).slice(0, DESCRIPTION_MAX_LENGTH)
}

/** Whether a write of this module is saving the Model's milestones right now, in this transaction. */
export function writingModelLifecycle(modelId: string): boolean {
    return writing.has(modelId)
}

/**
 * Queue the recomputation of a NaaS Model's fleet assets (entry/models `refreshModelAssets`). The event is the
 * Model's: a milestone row may be gone by the time it runs. A Model that is not a NaaS Model (ADR 0016) queues nothing.
 */
export function queueModelRefresh(modelId: string): void {
    const model = findById('cmdb_model', modelId)
    if (model && isNaasModel(str(model, OEM_PID_FIELD))) queueJob(EVENT.lifecycleChanged, model)
}

/**
 * Queue that recomputation for each NaaS Model (ADR 0016) with a milestone, of any source, dated `day`: its phase
 * changes on that day without any record changing.
 */
export function queueModelsReachingMilestone(day: string): void {
    const queued = new Set<string>()
    const row = new GlideRecord(MODEL_LIFECYCLE.table)
    row.addEncodedQuery(`${MILESTONE_ROWS}^start_date=${day}^${naasModelCondition('model.')}`)
    row.query()
    while (row.next()) {
        const modelId = str(row, 'model')
        if (queued.has(modelId)) continue
        queued.add(modelId)
        queueModelRefresh(modelId)
    }
}

/**
 * Import a lifecycle row: store its milestones on its Model. A milestone the
 * row leaves blank keeps what is stored, so a row whose milestones go backwards counted with those is refused whole. A
 * row with a milestone the platform refuses is marked error with why, to load again once the cause is fixed: the
 * milestones saved meanwhile are then found as given.
 */
export function importLifecycleRow(row: GlideRecord): RowOutcome {
    // The import table's milestone columns are named after their phases.
    const dates = Object.fromEntries(MILESTONES.map(({ field, phase }) => [field, str(row, phase)]))
    const parsed = parseLifecycleRow({ pid: str(row, 'pid'), ...dates })
    if (!parsed.ok) return rowError(parsed.reason)
    if (Object.keys(parsed.dates).length === 0) return { state: 'ignored', comment: `No milestone date${parsed.pid ? ` for ${parsed.pid}` : ''}` }

    const resolution = resolveModel({ manufacturer: str(row, 'manufacturer'), model: parsed.pid }, loadNormalizationData())
    if (!resolution.matched) return rowError(`PID ${parsed.pid} does not map to a model`)
    const backwards = backwardsMilestones(mergeLifecycle(readModelLifecycle(resolution.modelId), parsed.dates))
    if (backwards) return rowError(`${backwards}, counting the milestones stored for ${parsed.pid}`)

    const written = writeModelLifecycle(resolution.modelId, parsed.dates, { source: 'csv', reference: str(row, 'source_reference') })
    if (written.refused.length > 0) return rowError(`Lifecycle for ${parsed.pid} not saved: ${written.refused.join('; ')}`)
    return { state: written.updated + written.unchanged > 0 ? 'updated' : 'inserted', comment: `Lifecycle for ${parsed.pid}` }
}
