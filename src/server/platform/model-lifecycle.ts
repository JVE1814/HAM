import { GlideRecord } from '@servicenow/glide'
import { naasModelCondition } from '../domain/fleet.ts'
import { createMarks } from '../domain/marks.ts'
import { mergeLifecycle, type LifecycleDates } from '../domain/model-lifecycle.ts'
import type { OemVendor } from '../domain/vocabulary.ts'
import { EVENT, fire } from './events.ts'
import { findById, refusal, str } from './records.ts'

/**
 * A Model's manufacturer support milestones, kept in the platform's Model lifecycle table (ADR 0017): one row per
 * Model and milestone, the milestone in `lifecycle_phase` and its date in `start_date`. Only this module reads and
 * writes the table and knows its phase names; the rest of the app works with `LifecycleDates`.
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

/** Every class of row: what the app reads. */
const TABLE = 'cmdb_model_lifecycle'

/** The class the app creates its rows in: NaaS Models are hardware Models. */
const HARDWARE_TABLE = 'cmdb_hardware_model_lifecycle'

/** `lifecycle_type` of a manufacturer's milestone; the other, Internal, is an organisation's own plan for a Model. */
const PUBLISHER = 'publisher'

/** `source` of the rows the app writes (and of those maintained by hand); ServiceNow's content rows carry another. */
const OWN_SOURCE = 'internal'

/** The platform's `lifecycle_phase` of each milestone. Its General availability phase is no milestone of the app's. */
const PHASE_OF: Readonly<Record<keyof LifecycleDates, string>> = {
    endOfSale: 'end_of_sale',
    endOfSupport: 'end_of_support',
    endOfExtendedSupport: 'end_of_extended_support',
    endOfLife: 'end_of_life',
}

const MILESTONES = Object.keys(PHASE_OF) as Array<keyof LifecycleDates>

/** Active manufacturer milestone rows, of any class and source. */
const MILESTONE_ROWS = `active=true^lifecycle_type=${PUBLISHER}^lifecycle_phaseIN${Object.values(PHASE_OF).join(',')}`

/** The Model's rows the app writes: the platform keeps them to one per milestone. */
const OWN_ROWS = `${MILESTONE_ROWS}^source=${OWN_SOURCE}`

/** The description column's length. */
const DESCRIPTION_MAX_LENGTH = 1000

/** Who can give a milestone's date. */
export type LifecycleSource = 'manual' | 'csv' | OemVendor

/** Each source as a row's description names it. */
const SOURCE_LABEL: Readonly<Record<LifecycleSource, string>> = {
    manual: 'Manual',
    csv: 'CSV import',
    cisco: 'Cisco EoX API',
    meraki: 'Meraki Dashboard API',
    fortinet: 'Fortinet Asset Management API',
    mist: 'HPE Mist API',
    aruba: 'HPE Aruba',
    checkpoint: 'Check Point',
}

/** Where a milestone's date comes from: kept as one line in the row's description. */
export interface LifecycleProvenance {
    source: LifecycleSource
    /** The bulletin or document the source gives the date in (a URL or an id), when it names one. */
    reference?: string
}

/** What a write did with the milestones it was given. */
export interface LifecycleWrite {
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
    return MILESTONES.find((milestone) => PHASE_OF[milestone] === phase)
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
    const row = new GlideRecord(TABLE)
    row.addQuery('model', modelId)
    row.addEncodedQuery(`${MILESTONE_ROWS}^start_dateISNOTEMPTY`)
    row.orderBy('sys_updated_on')
    row.query()
    while (row.next()) {
        const milestone = milestoneOf(str(row, 'lifecycle_phase'))
        if (!milestone) continue
        const dates = str(row, 'source') === OWN_SOURCE ? own : others
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
    const pending = new Map<string, string>()
    for (const milestone of MILESTONES) {
        const date = dates[milestone]
        if (date) pending.set(PHASE_OF[milestone], date)
    }
    if (!modelId || pending.size === 0) return result
    const description = provenanceLine(provenance)
    let dated = ''
    const save = (row: GlideRecord, phase: string, date: string, stored: boolean): void => {
        const moved = str(row, 'start_date') !== date
        row.setValue('start_date', date)
        row.setValue('description', description)
        if (!(stored ? row.update() : row.insert())) {
            return void result.refused.push(`${phase.replace(/_/g, ' ')}: ${refusal(row)}`)
        }
        if (stored) result.updated++
        else result.inserted++
        if (moved) dated = row.getUniqueValue()
    }
    writing.during(modelId, () => {
        const stored = new GlideRecord(TABLE)
        stored.addQuery('model', modelId)
        stored.addEncodedQuery(OWN_ROWS)
        stored.query()
        while (stored.next()) {
            const phase = str(stored, 'lifecycle_phase')
            const date = pending.get(phase)
            if (date === undefined) continue
            pending.delete(phase)
            if (str(stored, 'start_date') === date && str(stored, 'description') === description) result.unchanged++
            else save(stored, phase, date, true)
        }
        for (const [phase, date] of pending) {
            const fresh = new GlideRecord(HARDWARE_TABLE)
            fresh.initialize()
            fresh.setValue('model', modelId)
            fresh.setValue('lifecycle_type', PUBLISHER)
            fresh.setValue('source', OWN_SOURCE)
            fresh.setValue('lifecycle_phase', phase)
            fresh.setValue('active', true)
            save(fresh, phase, date, false)
        }
    })
    const row = findById(TABLE, dated)
    if (row) queueModelRefresh(row)
    return result
}

function provenanceLine(provenance: LifecycleProvenance): string {
    const label = SOURCE_LABEL[provenance.source]
    const reference = (provenance.reference ?? '').trim()
    return (reference ? `${label}: ${reference}` : label).slice(0, DESCRIPTION_MAX_LENGTH)
}

/** Whether a write of this module is saving the Model's milestones right now, in this transaction. */
export function writingModelLifecycle(modelId: string): boolean {
    return writing.has(modelId)
}

/** Queue the recomputation of the fleet assets of a lifecycle row's Model (entry/models `refreshModelAssets`). */
export function queueModelRefresh(row: GlideRecord): void {
    fire(EVENT.lifecycleChanged, row, str(row, 'model'), '')
}

/**
 * Queue that recomputation for each NaaS Model (ADR 0016) with a milestone, of any source, dated `day`: its phase
 * changes on that day without any record changing.
 */
export function queueModelsReachingMilestone(day: string): void {
    const queued = new Set<string>()
    const row = new GlideRecord(TABLE)
    row.addEncodedQuery(`${MILESTONE_ROWS}^start_date=${day}^${naasModelCondition('model.')}`)
    row.query()
    while (row.next()) {
        const modelId = str(row, 'model')
        if (queued.has(modelId)) continue
        queued.add(modelId)
        queueModelRefresh(row)
    }
}
