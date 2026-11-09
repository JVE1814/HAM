import { GlideDateTime, GlideRecord, gs } from '@servicenow/glide'
import { coverageDisposition, type CoverageAnswer } from '../domain/coverage.ts'
import { naasModelCondition, OEM_PID_FIELD } from '../domain/fleet.ts'
import { enabledRoutes, type CoverageRoute } from '../domain/oem/adapters.ts'
import type { OemVendor } from '../domain/vocabulary.ts'
import { nowMs } from './clock.ts'
import { applyCoverage, staleAssets } from './coverage.ts'
import { writeModelLifecycle } from './model-lifecycle.ts'
import { oemContext, oemEnabled } from './oem-http.ts'
import { recordRmaStatuses, rmasToAskAbout } from './oem-rma.ts'
import { intProperty, PROPERTY } from './properties.ts'
import { str } from './records.ts'

/**
 * OEM lifecycle, coverage and RMA-status synchronisation (P2.1, ADR 0008), of NaaS Models and the serials of fleet
 * assets only (ADR 0016): the Provider IT's equipment is never sent to an OEM. Each sync takes the vendors whose
 * route may run in turn (domain/oem/adapters `enabledRoutes`), asks the vendor, and logs what it could not get or save.
 */

/** Assets per coverage batch. */
const COVERAGE_BATCH = 200

/** The most errors of one answer that are logged: a vendor that is down fails every key the same way. */
const ERRORS_LOGGED = 20

function report(job: string, errors: readonly string[]): void {
    for (const error of errors.slice(0, ERRORS_LOGGED)) gs.warn(`[x_daas_ham] ${job}: ${error}`)
}

/** `vendor`'s NaaS Models (those with an OEM PID), by PID. */
function naasModelsByPid(vendor: OemVendor): Map<string, string> {
    const models = new Map<string, string>()
    const model = new GlideRecord('cmdb_model')
    model.addQuery('x_daas_ham_oem_source', vendor)
    model.addEncodedQuery(naasModelCondition())
    model.query()
    while (model.next()) models.set(str(model, OEM_PID_FIELD), model.getUniqueValue())
    return models
}

/** EoX milestones for NaaS Models of every vendor with a lifecycle API. */
export function syncLifecycle(): void {
    for (const { vendor, route } of enabledRoutes('lifecycle', oemEnabled)) {
        const models = naasModelsByPid(vendor)
        const result = route.run([...models.keys()], oemContext(route.via))
        report(`lifecycle ${vendor}`, result.errors)
        // New dates win; dates the vendor does not give (e.g. a CSV end of life) are kept.
        const refused: string[] = []
        for (const fact of result.facts) {
            const modelId = models.get(fact.pid)
            if (!modelId) continue
            const written = writeModelLifecycle(modelId, fact.dates, { source: vendor, reference: fact.reference })
            refused.push(...written.refused.map((why) => `${fact.pid} not saved: ${why}`))
        }
        report(`lifecycle ${vendor}`, refused)
    }
}

/**
 * OEM coverage of assets not checked for x_daas_ham.oem.coverage_refresh_days, oldest first, until the jobs' time
 * budget is spent. The enabled vendors take turns, one batch each per round, so one with a backlog cannot starve the
 * others and none leaves the budget unused while another is behind. The first round runs whatever the time, so each
 * vendor gets at least one batch per run. Checked assets drop out of the query, so no cursor is needed.
 */
export function syncCoverage(): void {
    const started = nowMs()
    const budgetMs = intProperty(PROPERTY.jobBudgetSeconds, 120) * 1000
    const staleBefore = new GlideDateTime()
    staleBefore.addDaysUTC(-intProperty('x_daas_ham.oem.coverage_refresh_days', 7))
    let due = enabledRoutes('coverage', oemEnabled)
    for (let round = 0; due.length > 0; round++) {
        const behind: typeof due = []
        for (const turn of due) {
            if (round > 0 && nowMs() - started > budgetMs) return
            if (syncCoverageBatch(turn.vendor, turn.route, staleBefore.getValue())) behind.push(turn)
        }
        due = behind
    }
}

/**
 * One batch of `vendor`'s stale Assets; returns whether the vendor gets another batch this run. A batch reads
 * and writes its serials' stored coverage with one query, and updates its Assets from another.
 */
function syncCoverageBatch(vendor: OemVendor, route: CoverageRoute, staleBefore: string): boolean {
    const assets = staleAssets(vendor, staleBefore, route.maxKeysPerRun ?? COVERAGE_BATCH)
    if (assets.size === 0) return false
    const result = route.run([...assets.keys()], oemContext(route.via))
    report(`coverage ${vendor}`, result.errors)
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
    report(`coverage ${vendor}`, refused)
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
    for (const { vendor, route } of enabledRoutes('rmaStatus', oemEnabled)) {
        const asked = rmasToAskAbout(vendor)
        if (asked.ids.length === 0) continue
        const result = route.run(asked.rmaNumbers, oemContext(route.via))
        report(`rma ${vendor}`, result.errors)
        const statusOf = new Map(result.facts.map((fact) => [fact.rmaNumber, fact.status]))
        report(`rma ${vendor}`, recordRmaStatuses(asked.ids, statusOf))
    }
}
