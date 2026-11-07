// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideDateTime, GlideRecord, gs } from '@servicenow/glide'
import { isIsoDate } from '../domain/calendar'
import { annualSupportCost, coverageDisposition, coverageSummary, mergeCoverage, type CoverageView } from '../domain/coverage'
import { mergeLifecycle, type LifecycleDates } from '../domain/model-lifecycle'
import { OEM_ADAPTERS } from '../domain/oem/adapters'
import type { CoverageFact, OemVendor } from '../domain/oem/types'
import { normalizeSerial } from '../domain/asn'
import { msToGlide, nowMs, todayIso } from '../platform/clock'
import { oemContext, oemEnabled } from '../platform/oem-http'
import { intProperty } from '../platform/properties'
import { bool, num, str } from '../platform/records'

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
 * assets drop out of the query, so no cursor is needed. A batch reads its stored coverage, its Assets'
 * contracts and the Assets with one query each.
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
            const answered: string[] = []
            const answers: CoverageAnswer[] = []
            const stamped: string[] = []
            for (const [serial, assetIds] of assets) {
                const disposition = dispositionOf(serial)
                if (disposition.kind === 'stamp') stamped.push(...assetIds)
                if (disposition.kind !== 'apply') continue
                answered.push(...assetIds)
                for (const assetId of assetIds) for (const fact of disposition.facts) answers.push({ assetId, fact })
            }
            const checkedAt = msToGlide(nowMs())
            const saved = writeCoverage(vendor, 'api', answers, checkedAt)
            refreshAssetCoverage(answered, saved, stamped, checkedAt)
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
    while (asset.next()) {
        const serial = normalizeSerial(str(asset, 'serial_number'))
        assets.set(serial, [...(assets.get(serial) ?? []), asset.getUniqueValue()])
    }
    return assets
}

/** One answered contract to write onto an Asset's coverage; the annual cost comes only with a CSV import row. */
interface CoverageAnswer {
    assetId: string
    fact: CoverageFact
    annualCost?: number
}

/** A coverage contract's identity: serial and contract number, ignoring case as the database's own match does. */
function contractKey(serial: string, contractNumber: string): string {
    return `${normalizeSerial(serial)}\n${contractNumber}`.toLowerCase()
}

/**
 * Write the answered contracts onto their coverage records, found by serial and contract number with one query
 * for all the answers' serials (of duplicate stored records, the first found is updated). Answers for the same
 * contract, as for duplicate Assets sharing a serial, are set on the record one after the other and saved once, so
 * the last Asset gets the record. Returns the sys_ids of the saved records by Asset.
 */
function writeCoverage(vendor: OemVendor, source: 'api' | 'csv', answers: readonly CoverageAnswer[], checkedAt: string): Map<string, string[]> {
    const pending = new Map<string, CoverageAnswer[]>()
    for (const answer of answers) {
        const key = contractKey(answer.fact.serial, answer.fact.contractNumber)
        pending.set(key, [...(pending.get(key) ?? []), answer])
    }
    const saved = new Map<string, string[]>()
    const save = (record: GlideRecord, contractAnswers: readonly CoverageAnswer[], exists: boolean) => {
        for (const answer of contractAnswers) setCoverage(record, vendor, source, answer, checkedAt)
        const id = exists ? record.update() : record.insert()
        if (!id) return
        for (const assetId of new Set(contractAnswers.map((answer) => answer.assetId))) saved.set(assetId, [...(saved.get(assetId) ?? []), id])
    }
    if (pending.size === 0) return saved
    const stored = new GlideRecord('x_daas_ham_oem_coverage')
    stored.addQuery('serial_number', 'IN', [...new Set(answers.map((answer) => normalizeSerial(answer.fact.serial)))].join(','))
    stored.query()
    while (stored.next()) {
        const key = contractKey(str(stored, 'serial_number'), str(stored, 'contract_number'))
        const contractAnswers = pending.get(key)
        if (!contractAnswers) continue
        pending.delete(key)
        save(stored, contractAnswers, true)
    }
    for (const contractAnswers of pending.values()) {
        const fresh = new GlideRecord('x_daas_ham_oem_coverage')
        fresh.initialize()
        save(fresh, contractAnswers, false)
    }
    return saved
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
 * Re-summarise each answered Asset's coverage contracts onto it, and stamp it and each `stamped` Asset (the vendor
 * answered with an error: its coverage is kept) checked, with one query for the contracts and one for the Assets.
 */
function refreshAssetCoverage(answered: readonly string[], saved: ReadonlyMap<string, readonly string[]>, stamped: readonly string[], checkedAt: string): void {
    const ids = [...answered, ...stamped]
    if (ids.length === 0) return
    const contracts = contractsOf(answered, saved)
    const today = todayIso()
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('sys_id', 'IN', ids.join(','))
    asset.query()
    while (asset.next()) {
        const views = contracts.get(asset.getUniqueValue())
        if (views) {
            const summary = coverageSummary(views, today)
            asset.setValue('x_daas_ham_coverage_end', summary.coverageEnd)
            asset.setValue('x_daas_ham_coverage_level', summary.serviceLevel)
            asset.setValue('x_daas_ham_support_cost', annualSupportCost(views, today))
        }
        asset.setValue('x_daas_ham_coverage_checked', checkedAt)
        asset.update()
    }
}

/**
 * The coverage contracts of each answered Asset, read with one query: those pointing at it, and those just saved
 * for it, which a duplicate Asset sharing its serial keeps although the record now points at the last duplicate.
 */
function contractsOf(answered: readonly string[], saved: ReadonlyMap<string, readonly string[]>): Map<string, CoverageView[]> {
    const byAsset = new Map(answered.map((assetId) => [assetId, new Map<string, CoverageView>()]))
    if (byAsset.size === 0) return new Map()
    const savedIds = [...new Set([...saved.values()].flat())]
    const byId = new Map<string, CoverageView>()
    const coverage = new GlideRecord('x_daas_ham_oem_coverage')
    coverage.addEncodedQuery(`assetIN${[...byAsset.keys()].join(',')}${savedIds.length > 0 ? `^ORsys_idIN${savedIds.join(',')}` : ''}`)
    coverage.query()
    while (coverage.next()) {
        const view: CoverageView = {
            covered: bool(coverage, 'covered'),
            endDate: str(coverage, 'end_date') || undefined,
            serviceLevel: str(coverage, 'service_level'),
            annualCost: num(coverage, 'annual_cost'),
        }
        byId.set(coverage.getUniqueValue(), view)
        byAsset.get(str(coverage, 'asset'))?.set(coverage.getUniqueValue(), view)
    }
    for (const [assetId, ids] of saved) {
        for (const id of ids) {
            const view = byId.get(id)
            if (view) byAsset.get(assetId)?.set(id, view)
        }
    }
    return new Map([...byAsset].map(([assetId, views]) => [assetId, [...views.values()]]))
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
    if ((start && !isIsoDate(start)) || (end && !isIsoDate(end))) return finish('error', 'dates must be YYYY-MM-DD')
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
    const checkedAt = msToGlide(nowMs())
    const saved = writeCoverage(vendor, 'csv', [{ assetId, fact, annualCost: cost ? Number(cost) : undefined }], checkedAt)
    refreshAssetCoverage([assetId], saved, [], checkedAt)
    finish('inserted', `Coverage for ${serial}`)
}
