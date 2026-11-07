// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideDateTime, GlideRecord, gs } from '@servicenow/glide'
import { isIsoDate } from '../domain/calendar'
import { coverageSummary, type CoverageView } from '../domain/coverage'
import { mergeLifecycle, type LifecycleDates } from '../domain/model-lifecycle'
import { OEM_ADAPTERS } from '../domain/oem/adapters'
import type { CoverageFact, OemVendor } from '../domain/oem/types'
import { normalizeSerial } from '../domain/asn'
import { msToGlide, nowMs, todayIso } from '../platform/clock'
import { oemContext, oemEnabled } from '../platform/oem-http'
import { intProperty } from '../platform/properties'
import { bool, str } from '../platform/records'

/** OEM lifecycle, coverage and RMA-status synchronisation (P2.1, ADR 0008). */

const VENDORS: readonly OemVendor[] = ['cisco', 'meraki', 'fortinet', 'mist', 'aruba', 'checkpoint']

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
 * first, until the time budget is spent. Checked assets drop out of the query, so no cursor is needed.
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
            const assets = staleAssets(vendor, staleBefore.getValue(), 200)
            if (assets.size === 0) break
            const result = route.run([...assets.keys()], oemContext(route.via))
            report(`coverage ${vendor}`, result.errors)
            const factsBySerial = new Map<string, CoverageFact[]>()
            for (const fact of result.facts) {
                const key = normalizeSerial(fact.serial)
                factsBySerial.set(key, [...(factsBySerial.get(key) ?? []), fact])
            }
            // A failed call says nothing about its serials: leave them stale for the next run and
            // move on, rather than stamping them checked or asking again straight away.
            const failed = result.errors.length > 0
            for (const [serial, assetIds] of assets) {
                const facts = factsBySerial.get(serial) ?? []
                if (failed && facts.length === 0) continue
                for (const assetId of assetIds) {
                    for (const fact of facts) upsertCoverage(assetId, vendor, fact, 'api')
                    refreshAssetCoverage(assetId)
                }
            }
            if (failed) break
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
    while (asset.next()) {
        const serial = normalizeSerial(str(asset, 'serial_number'))
        assets.set(serial, [...(assets.get(serial) ?? []), asset.getUniqueValue()])
    }
    return assets
}

function upsertCoverage(assetId: string, vendor: OemVendor, fact: CoverageFact, source: 'api' | 'csv'): void {
    const coverage = new GlideRecord('x_daas_ham_oem_coverage')
    coverage.addQuery('serial_number', normalizeSerial(fact.serial))
    coverage.addQuery('contract_number', fact.contractNumber)
    coverage.setLimit(1)
    coverage.query()
    const exists = coverage.next()
    if (!exists) coverage.initialize()
    coverage.setValue('asset', assetId)
    coverage.setValue('serial_number', normalizeSerial(fact.serial))
    coverage.setValue('vendor', vendor)
    coverage.setValue('contract_number', fact.contractNumber)
    coverage.setValue('service_level', fact.serviceLevel)
    coverage.setValue('covered', fact.covered)
    coverage.setValue('start_date', fact.startDate ?? '')
    // A renewed contract (new end date) can expire again: warn about it afresh.
    if (str(coverage, 'end_date') !== (fact.endDate ?? '')) coverage.setValue('expiry_notified', false)
    coverage.setValue('end_date', fact.endDate ?? '')
    coverage.setValue('source', source)
    coverage.setValue('last_checked', msToGlide(nowMs()))
    if (exists) coverage.update()
    else coverage.insert()
}

/** Re-summarise an asset's coverage contracts onto the asset and stamp it checked. */
export function refreshAssetCoverage(assetId: string): void {
    const asset = new GlideRecord('alm_hardware')
    if (!asset.get(assetId)) return
    const contracts: CoverageView[] = []
    const coverage = new GlideRecord('x_daas_ham_oem_coverage')
    coverage.addQuery('asset', assetId)
    coverage.query()
    while (coverage.next()) {
        contracts.push({ covered: bool(coverage, 'covered'), endDate: str(coverage, 'end_date') || undefined, serviceLevel: str(coverage, 'service_level') })
    }
    const summary = coverageSummary(contracts, todayIso())
    asset.setValue('x_daas_ham_coverage_end', summary.coverageEnd)
    asset.setValue('x_daas_ham_coverage_level', summary.serviceLevel)
    asset.setValue('x_daas_ham_coverage_checked', msToGlide(nowMs()))
    asset.update()
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
    if (!VENDORS.includes(vendor)) return finish('error', `vendor must be one of ${VENDORS.join(', ')}`)
    if (!serial) return finish('error', 'serial number is required')
    if ((start && !isIsoDate(start)) || (end && !isIsoDate(end))) return finish('error', 'dates must be YYYY-MM-DD')
    const asset = new GlideRecord('alm_hardware')
    if (!asset.get('serial_number', serial)) return finish('error', `no asset with serial ${serial}`)
    upsertCoverage(
        asset.getUniqueValue(),
        vendor,
        {
            serial,
            covered: true,
            contractNumber: str(current, 'contract_number'),
            serviceLevel: str(current, 'service_level'),
            startDate: start || undefined,
            endDate: end || undefined,
        },
        'csv',
    )
    refreshAssetCoverage(asset.getUniqueValue())
    finish('inserted', `Coverage for ${serial}`)
}
