// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideDateTime, GlideRecord, gs } from '@servicenow/glide'
import { isIsoDate } from '../domain/calendar'
import { appendTo } from '../domain/collections'
import {
    answersByContract,
    contractKey,
    coverageBySerial,
    coverageDisposition,
    mergeCoverage,
    type AssetCoverage,
    type CoverageAnswer,
    type SerialCoverage,
} from '../domain/coverage'
import { mergeLifecycle, type LifecycleDates } from '../domain/model-lifecycle'
import { OEM_ADAPTERS } from '../domain/oem/adapters'
import type { CoverageFact, OemVendor } from '../domain/oem/types'
import { normalizeSerial } from '../domain/asn'
import { msToGlide, nowMs, todayIso } from '../platform/clock'
import { oemContext, oemEnabled } from '../platform/oem-http'
import { intProperty } from '../platform/properties'
import { addAnyOf, bool, num, str } from '../platform/records'

/** OEM lifecycle, coverage and RMA-status synchronisation (P2.1, ADR 0008). */

const VENDORS: readonly OemVendor[] = ['cisco', 'meraki', 'fortinet', 'mist', 'aruba', 'checkpoint']

/** Assets per coverage batch. */
const COVERAGE_BATCH = 200

function report(job: string, errors: readonly string[]): void {
    for (const error of errors.slice(0, 20)) gs.warn(`[x_daas_ham] ${job}: ${error}`)
}

/** Daily: EoX milestones for canonical models of every vendor with a lifecycle API. */
export function syncOemLifecycle(): void {
    for (const vendor of VENDORS) {
        const route = OEM_ADAPTERS[vendor].lifecycle
        if (!route || !oemEnabled(route.via)) continue
        const models = new Map<string, string>()
        const model = new GlideRecord('cmdb_model')
        model.addQuery('x_daas_ham_oem_source', vendor)
        model.addNotNullQuery('x_daas_ham_oem_pid')
        model.query()
        while (model.next()) models.set(str(model, 'x_daas_ham_oem_pid'), model.getUniqueValue())

        const result = route.run([...models.keys()], oemContext(route.via))
        report(`lifecycle ${vendor}`, result.errors)
        for (const fact of result.facts) {
            const modelId = models.get(fact.pid)
            if (modelId) upsertLifecycle(modelId, fact.dates, vendor, fact.reference)
        }
    }
}

function upsertLifecycle(modelId: string, incoming: LifecycleDates, vendor: OemVendor, reference: string): void {
    const lifecycle = new GlideRecord('x_daas_ham_model_lifecycle')
    const exists = lifecycle.get('model', modelId)
    if (!exists) {
        lifecycle.initialize()
        lifecycle.setValue('model', modelId)
    }
    // New dates win; dates the vendor does not give (e.g. a CSV end of life) are kept.
    const merged = mergeLifecycle(
        {
            endOfSale: str(lifecycle, 'end_of_sale') || undefined,
            endOfSupport: str(lifecycle, 'end_of_support') || undefined,
            endOfExtendedSupport: str(lifecycle, 'end_of_extended_support') || undefined,
            endOfLife: str(lifecycle, 'end_of_life') || undefined,
        },
        incoming,
    )
    lifecycle.setValue('end_of_sale', merged.endOfSale ?? '')
    lifecycle.setValue('end_of_support', merged.endOfSupport ?? '')
    lifecycle.setValue('end_of_extended_support', merged.endOfExtendedSupport ?? '')
    lifecycle.setValue('end_of_life', merged.endOfLife ?? '')
    lifecycle.setValue('source', vendor)
    lifecycle.setValue('source_reference', reference)
    lifecycle.setValue('last_refreshed', new GlideDateTime().getValue())
    if (exists) lifecycle.update()
    else lifecycle.insert()
}

/**
 * Every 4 hours: OEM coverage of assets not checked for x_daas_ham.oem.coverage_refresh_days, oldest
 * first, until the time budget is spent (a rate-limited vendor: one batch of its maxKeysPerRun). Checked
 * assets drop out of the query, so no cursor is needed. A batch reads and writes its serials' stored
 * coverage with one query, and updates its Assets from another.
 */
export function syncOemCoverage(): void {
    const started = nowMs()
    const budgetMs = intProperty('x_daas_ham.job.budget_seconds', 120) * 1000
    const staleBefore = new GlideDateTime()
    staleBefore.addDaysUTC(-intProperty('x_daas_ham.oem.coverage_refresh_days', 7))
    for (const vendor of VENDORS) {
        const route = OEM_ADAPTERS[vendor].coverage
        if (!route || !oemEnabled(route.via)) continue
        for (;;) {
            if (nowMs() - started > budgetMs) return
            const assets = staleAssets(vendor, staleBefore.getValue(), route.maxKeysPerRun ?? COVERAGE_BATCH)
            if (assets.size === 0) break
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
            applyCoverage(vendor, 'api', answered, answers, stamped)
            // A batch with errors ends the vendor's run; a rate-limited vendor gets one batch per run.
            if (result.errors.length > 0 || route.maxKeysPerRun !== undefined) break
        }
    }
}

/** Stale Assets by normalized serial (a serial can be shared by duplicate records). */
function staleAssets(vendor: OemVendor, staleBefore: string, limit: number): Map<string, string[]> {
    const asset = new GlideRecord('alm_hardware')
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

/** Write the answers onto the answered serials' coverage (writeCoverage) and summarise it onto the Assets (refreshAssetCoverage), with one check time; shared by the API sync and the CSV import. */
function applyCoverage(vendor: OemVendor, source: 'api' | 'csv', answered: ReadonlyMap<string, string>, answers: readonly CoverageAnswer[], stamped: readonly string[]): void {
    const checkedAt = msToGlide(nowMs())
    const serials = [...new Set(answered.values())]
    const contracts = writeCoverage(vendor, source, serials, answers, checkedAt)
    refreshAssetCoverage(answered, coverageBySerial(serials, contracts, todayIso()), stamped, checkedAt)
}

/**
 * Write the answered contracts of `serials` (normalised) onto their coverage records, found by serial and
 * contract number with one query (of duplicate stored records, the first found is updated) and created when
 * missing; answers for the same contract are set on its record one after the other and saved once. Returns
 * every stored contract of `serials` as it is after the write, which the Assets are summarised from.
 */
function writeCoverage(vendor: OemVendor, source: 'api' | 'csv', serials: readonly string[], answers: readonly CoverageAnswer[], checkedAt: string): SerialCoverage[] {
    const contracts: SerialCoverage[] = []
    if (serials.length === 0) return contracts
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
            stored.update()
        }
        contracts.push(contractOf(stored))
    }
    for (const contractAnswers of pending.values()) {
        const fresh = new GlideRecord('x_daas_ham_oem_coverage')
        fresh.initialize()
        for (const answer of contractAnswers) setCoverage(fresh, vendor, source, answer, checkedAt)
        if (fresh.insert()) contracts.push(contractOf(fresh))
    }
    return contracts
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
function setCoverage(coverage: GlideRecord, vendor: OemVendor, source: 'api' | 'csv', answer: CoverageAnswer, checkedAt: string): void {
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
 */
function refreshAssetCoverage(answered: ReadonlyMap<string, string>, coverageOf: ReadonlyMap<string, AssetCoverage>, stamped: readonly string[], checkedAt: string): void {
    const ids = [...answered.keys(), ...stamped]
    if (ids.length === 0) return
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
        asset.update()
    }
}

/** Hourly: status of open OEM RMAs for vendors with an RMA lookup API. */
export function syncOemRmaStatus(): void {
    for (const vendor of VENDORS) {
        const route = OEM_ADAPTERS[vendor].rmaStatus
        if (!route || !oemEnabled(route.via)) continue
        const rma = new GlideRecord('x_daas_ham_oem_rma')
        rma.addQuery('vendor', vendor)
        rma.addQuery('state', 'IN', 'open,replacement_received')
        rma.addNotNullQuery('rma_number')
        rma.setLimit(200)
        rma.query()
        const records = new Map<string, string>()
        while (rma.next()) records.set(str(rma, 'rma_number'), rma.getUniqueValue())
        const result = route.run([...records.keys()], oemContext(route.via))
        report(`rma ${vendor}`, result.errors)
        for (const fact of result.facts) {
            const record = new GlideRecord('x_daas_ham_oem_rma')
            if (!record.get(records.get(fact.rmaNumber) ?? '')) continue
            record.setValue('status', fact.status)
            record.setValue('last_synced', msToGlide(nowMs()))
            record.update()
        }
    }
}

/** After-insert rule on coverage import rows (vendors without an API). */
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
    const asset = new GlideRecord('alm_hardware')
    if (!asset.get('serial_number', serial)) return finish('error', `no asset with serial ${serial}`)
    const assetId = asset.getUniqueValue()
    const fact: CoverageFact = {
        serial,
        covered: true,
        contractNumber: str(current, 'contract_number'),
        serviceLevel: str(current, 'service_level'),
        startDate: start || undefined,
        endDate: end || undefined,
    }
    applyCoverage(vendor, 'csv', new Map([[assetId, serial]]), [{ assetId, fact, annualCost: cost ? Number(cost) : undefined }], [])
    finish('inserted', `Coverage for ${serial}`)
}
