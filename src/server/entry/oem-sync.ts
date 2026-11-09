import { GlideDateTime, GlideRecord, gs } from '@servicenow/glide'
import { isIsoDate } from '../domain/calendar.ts'
import { appendTo } from '../domain/collections.ts'
import {
    answersByContract,
    contractKey,
    coverageBySerial,
    coverageDisposition,
    mergeCoverage,
    type AssetCoverage,
    type CoverageAnswer,
    type SerialCoverage,
} from '../domain/coverage.ts'
import { fleetCondition, naasModelCondition } from '../domain/fleet.ts'
import { enabledRoute, type CoverageRoute } from '../domain/oem/adapters.ts'
import type { CoverageFact } from '../domain/oem/types.ts'
import { normalizeSerial } from '../domain/serials.ts'
import type { CoverageSource, OemVendor } from '../domain/vocabulary.ts'
import { msToGlide, nowMs, todayIso } from '../platform/clock.ts'
import { writeModelLifecycle } from '../platform/model-lifecycle.ts'
import { oemContext, oemEnabled } from '../platform/oem-http.ts'
import { intProperty } from '../platform/properties.ts'
import { addAnyOf, bool, num, refusal, str } from '../platform/records.ts'

/**
 * OEM lifecycle, coverage and RMA-status synchronisation (P2.1, ADR 0008), of NaaS Models and the serials of fleet
 * assets only (ADR 0016): the Provider IT's equipment is never sent to an OEM.
 */

const VENDORS: readonly OemVendor[] = ['cisco', 'meraki', 'fortinet', 'mist', 'aruba', 'checkpoint']

/** Assets per coverage batch. */
const COVERAGE_BATCH = 200

function report(job: string, errors: readonly string[]): void {
    for (const error of errors.slice(0, 20)) gs.warn(`[x_daas_ham] ${job}: ${error}`)
}

/** Daily: EoX milestones for NaaS Models (those with an OEM PID) of every vendor with a lifecycle API. */
export function syncOemLifecycle(): void {
    for (const vendor of VENDORS) {
        const route = enabledRoute(vendor, 'lifecycle', oemEnabled)
        if (!route) continue
        const models = new Map<string, string>()
        const model = new GlideRecord('cmdb_model')
        model.addQuery('x_daas_ham_oem_source', vendor)
        model.addEncodedQuery(naasModelCondition())
        model.query()
        while (model.next()) models.set(str(model, 'x_daas_ham_oem_pid'), model.getUniqueValue())

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
 * Every 4 hours: OEM coverage of assets not checked for x_daas_ham.oem.coverage_refresh_days, oldest
 * first, until the time budget is spent. The enabled vendors take turns, one batch each per round, so one
 * with a backlog cannot starve the others and none leaves the budget unused while another is behind. The
 * first round runs whatever the time, so each vendor gets at least one batch per run. Checked assets drop
 * out of the query, so no cursor is needed.
 */
export function syncOemCoverage(): void {
    const started = nowMs()
    const budgetMs = intProperty('x_daas_ham.job.budget_seconds', 120) * 1000
    const staleBefore = new GlideDateTime()
    staleBefore.addDaysUTC(-intProperty('x_daas_ham.oem.coverage_refresh_days', 7))
    let due = VENDORS.flatMap((vendor) => {
        const route = enabledRoute(vendor, 'coverage', oemEnabled)
        return route ? [{ vendor, route }] : []
    })
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

/** Stale fleet assets by normalized serial (a serial can be shared by duplicate records). */
function staleAssets(vendor: OemVendor, staleBefore: string, limit: number): Map<string, string[]> {
    const asset = new GlideRecord('alm_hardware')
    asset.addEncodedQuery(fleetCondition())
    asset.addQuery('model.x_daas_ham_oem_source', vendor)
    asset.addQuery('install_status', '!=', 7)
    asset.addNotNullQuery('serial_number')
    asset.addEncodedQuery(`x_daas_ham_coverage_checkedISEMPTY^ORx_daas_ham_coverage_checked<${staleBefore}`)
    asset.orderBy('x_daas_ham_coverage_checked')
    asset.setLimit(limit)
    asset.query()
    const assets = new Map<string, string[]>()
    while (asset.next()) appendTo(assets, normalizeSerial(str(asset, 'serial_number')), asset.getUniqueValue())
    return assets
}

/**
 * Write the answers onto the answered serials' coverage (writeCoverage) and summarise it onto the Assets
 * (refreshAssetCoverage), with one check time; shared by the API sync and the CSV import. Returns the saves the
 * platform refused: a serial whose coverage is refused leaves its Assets unsummarised and unchecked, so it is asked
 * again rather than summarised from contracts that were not stored.
 */
function applyCoverage(vendor: OemVendor, source: CoverageSource, answered: ReadonlyMap<string, string>, answers: readonly CoverageAnswer[], stamped: readonly string[]): string[] {
    const checkedAt = msToGlide(nowMs())
    const serials = [...new Set(answered.values())]
    const { contracts, refused } = writeCoverage(vendor, source, serials, answers, checkedAt)
    const saved = new Map([...answered].filter(([, serial]) => !refused.has(serial)))
    const unstamped = refreshAssetCoverage(saved, coverageBySerial(serials, contracts, todayIso()), stamped, checkedAt)
    return [...[...refused].map(([serial, reason]) => `coverage of ${serial} not saved: ${reason}`), ...unstamped]
}

/**
 * Write the answered contracts of `serials` (normalised) onto their coverage records, found by serial and
 * contract number with one query (of duplicate stored records, the first found is updated) and created when
 * missing; answers for the same contract are set on its record one after the other and saved once. Returns
 * every stored contract of `serials` as it is after the write, which the Assets are summarised from, and why
 * each serial with a refused save was refused.
 */
function writeCoverage(vendor: OemVendor, source: CoverageSource, serials: readonly string[], answers: readonly CoverageAnswer[], checkedAt: string): CoverageWrite {
    const contracts: SerialCoverage[] = []
    const refused = new Map<string, string>()
    if (serials.length === 0) return { contracts, refused }
    const refuse = (coverage: GlideRecord) => {
        const contract = str(coverage, 'contract_number')
        refused.set(str(coverage, 'serial_number'), `contract ${contract}: ${refusal(coverage)}`)
    }
    const pending = answersByContract(answers)
    const stored = new GlideRecord('x_daas_ham_oem_coverage')
    addAnyOf(stored, 'serial_number', serials)
    stored.query()
    while (stored.next()) {
        const key = contractKey(str(stored, 'serial_number'), str(stored, 'contract_number'))
        const contractAnswers = pending.get(key)
        if (contractAnswers) {
            pending.delete(key)
            for (const answer of contractAnswers) setCoverage(stored, vendor, source, answer, checkedAt)
            if (!stored.update()) refuse(stored)
        }
        contracts.push(contractOf(stored))
    }
    for (const contractAnswers of pending.values()) {
        const fresh = new GlideRecord('x_daas_ham_oem_coverage')
        fresh.initialize()
        for (const answer of contractAnswers) setCoverage(fresh, vendor, source, answer, checkedAt)
        if (fresh.insert()) contracts.push(contractOf(fresh))
        else refuse(fresh)
    }
    return { contracts, refused }
}

/** What writeCoverage stored: the contracts the Assets are summarised from, and why each refused serial was refused. */
interface CoverageWrite {
    contracts: SerialCoverage[]
    refused: Map<string, string>
}

function contractOf(coverage: GlideRecord): SerialCoverage {
    return {
        serial: str(coverage, 'serial_number'),
        covered: bool(coverage, 'covered'),
        endDate: str(coverage, 'end_date') || undefined,
        serviceLevel: str(coverage, 'service_level'),
        annualCost: num(coverage, 'annual_cost'),
    }
}

/** Set one answered contract on its coverage record; an answer set after another merges onto the dates it set. */
function setCoverage(coverage: GlideRecord, vendor: OemVendor, source: CoverageSource, answer: CoverageAnswer, checkedAt: string): void {
    const { fact } = answer
    const merged = mergeCoverage(
        { startDate: str(coverage, 'start_date') || undefined, endDate: str(coverage, 'end_date') || undefined },
        { startDate: fact.startDate, endDate: fact.endDate },
    )
    coverage.setValue('asset', answer.assetId)
    coverage.setValue('serial_number', normalizeSerial(fact.serial))
    coverage.setValue('vendor', vendor)
    coverage.setValue('contract_number', fact.contractNumber)
    coverage.setValue('service_level', fact.serviceLevel)
    coverage.setValue('covered', fact.covered)
    coverage.setValue('start_date', merged.startDate ?? '')
    coverage.setValue('end_date', merged.endDate ?? '')
    if (merged.resetExpiryNotified) coverage.setValue('expiry_notified', false)
    coverage.setValue('source', source)
    // The annual cost comes only from the CSV import; an API answer keeps the stored one.
    if (answer.annualCost !== undefined) coverage.setValue('annual_cost', answer.annualCost)
    coverage.setValue('last_checked', checkedAt)
}

/**
 * Give each answered Asset (by sys_id, with its normalised serial) its serial's coverage, and stamp it and each
 * `stamped` Asset (the vendor answered with an error: its coverage is kept) checked, with one query for the Assets.
 * Returns why each Asset the platform refused was refused (it stays unchecked, so it is asked again).
 */
function refreshAssetCoverage(answered: ReadonlyMap<string, string>, coverageOf: ReadonlyMap<string, AssetCoverage>, stamped: readonly string[], checkedAt: string): string[] {
    const refused: string[] = []
    const ids = [...answered.keys(), ...stamped]
    if (ids.length === 0) return refused
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('sys_id', 'IN', ids.join(','))
    asset.query()
    while (asset.next()) {
        const serial = answered.get(asset.getUniqueValue())
        const coverage = serial === undefined ? undefined : coverageOf.get(serial)
        if (coverage) {
            asset.setValue('x_daas_ham_coverage_end', coverage.coverageEnd)
            asset.setValue('x_daas_ham_coverage_level', coverage.serviceLevel)
            asset.setValue('x_daas_ham_support_cost', coverage.supportCost)
        }
        asset.setValue('x_daas_ham_coverage_checked', checkedAt)
        if (!asset.update()) refused.push(`${str(asset, 'serial_number')} not saved: ${refusal(asset)}`)
    }
    return refused
}

/**
 * Hourly: status of open OEM RMAs for vendors with an RMA lookup API, at most 200 per vendor, least recently
 * synced (never synced) first. Every RMA asked is stamped synced, answered or not, so the whole set rotates; one the
 * platform refuses is logged, as it keeps its place at the front and would take a turn of the others unseen.
 */
export function syncOemRmaStatus(): void {
    for (const vendor of VENDORS) {
        const route = enabledRoute(vendor, 'rmaStatus', oemEnabled)
        if (!route) continue
        const rma = new GlideRecord('x_daas_ham_oem_rma')
        rma.addQuery('vendor', vendor)
        rma.addQuery('state', 'IN', 'open,replacement_received')
        rma.addNotNullQuery('rma_number')
        rma.orderBy('last_synced')
        rma.setLimit(200)
        rma.query()
        const ids: string[] = []
        const rmaNumbers = new Set<string>()
        while (rma.next()) {
            ids.push(rma.getUniqueValue())
            rmaNumbers.add(str(rma, 'rma_number'))
        }
        if (ids.length === 0) continue
        const result = route.run([...rmaNumbers], oemContext(route.via))
        report(`rma ${vendor}`, result.errors)
        const statusOf = new Map(result.facts.map((fact) => [fact.rmaNumber, fact.status]))
        const syncedAt = msToGlide(nowMs())
        const refused: string[] = []
        const asked = new GlideRecord('x_daas_ham_oem_rma')
        asked.addQuery('sys_id', 'IN', ids.join(','))
        asked.query()
        while (asked.next()) {
            const status = statusOf.get(str(asked, 'rma_number'))
            if (status !== undefined) asked.setValue('status', status)
            asked.setValue('last_synced', syncedAt)
            if (!asked.update()) refused.push(`${str(asked, 'rma_number')} not saved: ${refusal(asked)}`)
        }
        report(`rma ${vendor}`, refused)
    }
}

/** After-insert rule on coverage import rows (vendors without an API): coverage of a fleet asset's serial only. */
export function processCoverageRow(current: GlideRecord): void {
    const finish = (state: string, comment: string) => {
        current.setValue('sys_import_state', state)
        current.setValue('sys_import_state_comment', comment)
        current.update()
    }
    const vendor = str(current, 'vendor') as OemVendor
    const serial = normalizeSerial(str(current, 'serial_number'))
    const start = str(current, 'start_date')
    const end = str(current, 'end_date')
    const cost = str(current, 'annual_cost').trim()
    if (!VENDORS.includes(vendor)) return finish('error', `vendor must be one of ${VENDORS.join(', ')}`)
    if (!serial) return finish('error', 'serial number is required')
    if ((start && !isIsoDate(start)) || (end && !isIsoDate(end))) return finish('error', 'dates must be real calendar dates (YYYY-MM-DD)')
    if (cost && !Number.isFinite(Number(cost))) return finish('error', 'annual cost must be a number')
    const asset = fleetAssetWithSerial(serial)
    if (!asset) return finish('error', `no fleet asset with serial ${serial}`)
    const assetId = asset.getUniqueValue()
    const fact: CoverageFact = {
        serial,
        covered: true,
        contractNumber: str(current, 'contract_number'),
        serviceLevel: str(current, 'service_level'),
        startDate: start || undefined,
        endDate: end || undefined,
    }
    const answer: CoverageAnswer = { assetId, fact, annualCost: cost ? Number(cost) : undefined }
    const refused = applyCoverage(vendor, 'csv', new Map([[assetId, serial]]), [answer], [])
    // Refused, the row is not imported: load it again once the cause is fixed.
    if (refused.length > 0) return finish('error', refused.join('; '))
    finish('inserted', `Coverage for ${serial}`)
}

/** The first fleet asset (ADR 0016) with this serial: one of the Provider IT's that carries it is not covered here. */
function fleetAssetWithSerial(serial: string): GlideRecord | null {
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('serial_number', serial)
    asset.addEncodedQuery(fleetCondition())
    asset.setLimit(1)
    asset.query()
    return asset.next() ? asset : null
}
