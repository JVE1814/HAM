import { GlideRecord } from '@servicenow/glide'
import { appendTo } from '../domain/collections.ts'
import { coverageDisposition, type CoverageAnswer } from '../domain/coverage.ts'
import { naasModelCondition, OEM_PID_FIELD } from '../domain/fleet.ts'
import type { HeldLock } from '../domain/job-lock.ts'
import { LOCK } from '../domain/lock-names.ts'
import { enabledRoutes, type CoverageRoute } from '../domain/oem/adapters.ts'
import { pidKey } from '../domain/oem/sync-adapters.ts'
import { PROPERTY } from '../domain/properties.ts'
import type { OemVendor } from '../domain/vocabulary.ts'
import { daysAgoGlide, nowMs } from './clock.ts'
import { applyCoverage, staleAssets } from './coverage.ts'
import { withLock } from './locks.ts'
import { log } from './log.ts'
import { writeModelLifecycle } from './model-lifecycle.ts'
import { apiEnabled, oemContext } from './oem-http.ts'
import { recordRmaStatuses, rmasToAskAbout } from './oem-rma.ts'
import { intProperty } from './properties.ts'
import { str } from './records.ts'

/**
 * OEM lifecycle, coverage and RMA-status synchronisation (P2.1, ADR 0008), of NaaS Models and the serials of fleet
 * assets only (ADR 0016): the Provider IT's equipment is never sent to an OEM. Each sync takes the vendors whose
 * route may run in turn (domain/oem/adapters `enabledRoutes`), asks the vendor, and logs what it could not get or save.
 */

/** Assets per coverage batch. */
const COVERAGE_BATCH = 200

/**
 * The most errors of one job and run that are logged: a vendor that is down fails every key the same way. The rest
 * are counted in one more line.
 */
const ERRORS_LOGGED = 20

/** Log a job's errors of one run, each naming its vendor: the first ERRORS_LOGGED, and a line counting the rest. */
function report(job: string, errors: readonly string[]): void {
    for (const error of errors.slice(0, ERRORS_LOGGED)) log.warn(`${job}: ${error}`)
    const more = errors.length - ERRORS_LOGGED
    if (more > 0) log.warn(`${job}: and ${more} more error(s) not logged`)
}

function ofVendor(vendor: OemVendor, errors: readonly string[]): string[] {
    return errors.map((error) => `${vendor}: ${error}`)
}

/**
 * `vendor`'s NaaS Models (those with an OEM PID), by PID as an OEM's answer is matched to them (domain/oem/sync-adapters
 * `pidKey`): the PID to ask for each key, as the first of its Models stores it (trimmed), and the Models with it.
 */
function naasModelsByPid(vendor: OemVendor): { asked: Map<string, string>; models: Map<string, string[]> } {
    const asked = new Map<string, string>()
    const models = new Map<string, string[]>()
    const model = new GlideRecord('cmdb_model')
    model.addQuery('x_daas_ham_oem_source', vendor)
    model.addEncodedQuery(naasModelCondition())
    model.query()
    while (model.next()) {
        const pid = str(model, OEM_PID_FIELD).trim()
        if (!pid) continue
        if (!asked.has(pidKey(pid))) asked.set(pidKey(pid), pid)
        appendTo(models, pidKey(pid), model.getUniqueValue())
    }
    return { asked, models }
}

/**
 * EoX milestones for NaaS Models of every vendor with a lifecycle API. Models are matched to the answer by PID
 * ignoring case and surrounding spaces, so a PID stored in lower case still gets its dates, and Models sharing a PID
 * each get them; one asked once. An answer for a PID no Model has is logged.
 */
export function syncLifecycle(): void {
    const runErrors: string[] = []
    for (const { vendor, route } of enabledRoutes('lifecycle', apiEnabled)) {
        const { asked, models } = naasModelsByPid(vendor)
        if (asked.size === 0) continue
        const result = route.run([...asked.values()], oemContext(route.api))
        const errors = [...result.errors]
        // New dates win; dates the vendor does not give (e.g. a CSV end of life) are kept.
        for (const fact of result.facts) {
            const modelIds = models.get(pidKey(fact.pid))
            if (!modelIds) errors.push(`an answer for PID ${fact.pid} matches no ${vendor} Model`)
            for (const modelId of modelIds ?? []) {
                // A refused save leaves the Model's stored dates as they were: the next daily run asks again.
                const written = writeModelLifecycle(modelId, fact.dates, { source: vendor, reference: fact.reference })
                errors.push(...written.refused.map((why) => `lifecycle of PID ${fact.pid} (Model ${modelId}) not saved: ${why}`))
            }
        }
        runErrors.push(...ofVendor(vendor, errors))
    }
    report('lifecycle', runErrors)
}

/**
 * OEM coverage of assets not checked for x_daas_ham.oem.coverage_refresh_days, oldest first, until the jobs' time
 * budget is spent. The enabled vendors take turns, one batch each per round, so one with a backlog cannot starve the
 * others and none leaves the budget unused while another is behind. The first round runs whatever the time, so each
 * vendor gets at least one batch per run. Checked assets drop out of the query, so no cursor is needed.
 *
 * The run holds its lock throughout (domain/lock-names `oemCoverageRun`, ADR 0013). Two runs at once (the 4-hourly job
 * and an *Execute now*) would load the same stalest Assets and both insert a serial's new contract, and the copy that
 * is not updated afterwards keeps a stale coverage end. A run that finds the lock held checks nothing; one that has
 * lost it starts no further batch.
 */
export function syncCoverage(): void {
    const lockName = LOCK.oemCoverageRun()
    if (withLock(lockName, syncCoverageHolding).ran) return
    log.info(`OEM coverage not checked: another run holds the ${lockName} lock and checks it`)
}

function syncCoverageHolding(lock: HeldLock): void {
    const started = nowMs()
    const budgetMs = intProperty(PROPERTY.jobBudgetSeconds) * 1000
    const staleBefore = daysAgoGlide(intProperty(PROPERTY.coverageRefreshDays))
    const errors: string[] = []
    let due = enabledRoutes('coverage', apiEnabled)
    try {
        for (let round = 0; due.length > 0; round++) {
            const behind: typeof due = []
            for (const turn of due) {
                if (round > 0 && nowMs() - started > budgetMs) return
                if (!lock.held()) return
                if (syncCoverageBatch(turn.vendor, turn.route, staleBefore, errors)) behind.push(turn)
            }
            due = behind
        }
    } finally {
        report('coverage', errors)
    }
}

/**
 * One batch of `vendor`'s stale Assets, adding what it could not get or save to the run's `errors`; returns whether
 * the vendor gets another batch this run. A batch reads and writes its serials' stored coverage with one query, and
 * updates its Assets from another.
 */
function syncCoverageBatch(vendor: OemVendor, route: CoverageRoute, staleBefore: string, errors: string[]): boolean {
    const assets = staleAssets(vendor, staleBefore, route.maxKeysPerRun ?? COVERAGE_BATCH)
    if (assets.size === 0) return false
    const result = route.run([...assets.keys()], oemContext(route.api))
    errors.push(...ofVendor(vendor, result.errors))
    const dispositionOf = coverageDisposition(result)
    const answered = new Map<string, string>()
    const answers: CoverageAnswer[] = []
    const stamped: string[] = []
    for (const [serial, assetIds] of assets) {
        const disposition = dispositionOf(serial)
        if (disposition.kind === 'stamp') stamped.push(...assetIds)
        if (disposition.kind !== 'apply') continue
        for (const assetId of assetIds) answered.set(assetId, serial)
        // The serial's coverage records point at its last answered Asset.
        const lastAsset = assetIds[assetIds.length - 1]
        for (const fact of disposition.facts) answers.push({ assetId: lastAsset, fact })
    }
    const refused = applyCoverage(vendor, 'api', answered, answers, stamped)
    errors.push(...ofVendor(vendor, refused))
    // A batch with errors ends the vendor's run, as does one with refused saves (its Assets, still stale, would come
    // straight back); a rate-limited vendor (maxKeysPerRun) gets one batch per run.
    return result.errors.length === 0 && refused.length === 0 && route.maxKeysPerRun === undefined
}

/**
 * Status of the open OEM RMAs of each vendor with an RMA lookup API (platform/oem-rma `rmasToAskAbout`). Every RMA
 * asked is stamped synced, answered or not, so the whole set rotates; one the platform refuses is logged, as it keeps
 * its place at the front and would take a turn of the others unseen.
 */
export function syncRmaStatus(): void {
    const errors: string[] = []
    for (const { vendor, route } of enabledRoutes('rmaStatus', apiEnabled)) {
        const asked = rmasToAskAbout(vendor)
        if (asked.ids.length === 0) continue
        const result = route.run(asked.rmaNumbers, oemContext(route.api))
        const statusOf = new Map(result.facts.map((fact) => [fact.rmaNumber, fact.status]))
        errors.push(...ofVendor(vendor, [...result.errors, ...recordRmaStatuses(asked.ids, statusOf)]))
    }
    report('rma', errors)
}
