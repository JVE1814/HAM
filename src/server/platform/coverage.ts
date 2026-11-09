import { GlideRecord } from '@servicenow/glide'
import { isIsoDate } from '../domain/calendar.ts'
import { appendTo } from '../domain/collections.ts'
import {
    answersByContract,
    contractKey,
    COVERAGE_CHECKED_FIELD,
    coverageBySerial,
    mergeCoverage,
    staleCoverageQuery,
    type AssetCoverage,
    type CoverageAnswer,
    type SerialCoverage,
} from '../domain/coverage.ts'
import { fleetCondition } from '../domain/fleet.ts'
import { SYNC_ORDER } from '../domain/oem/adapters.ts'
import type { CoverageFact } from '../domain/oem/types.ts'
import { normalizeSerial } from '../domain/serials.ts'
import type { CoverageSource, OemVendor } from '../domain/vocabulary.ts'
import { nowGlide, todayIso } from './clock.ts'
import type { RowOutcome } from './imports.ts'
import { addAnyOf, bool, num, refusal, str } from './records.ts'

/**
 * OEM coverage as stored (P2.1): the contracts of each serial (x_daas_ham_oem_coverage) and their summary on the
 * Assets, of fleet assets only (ADR 0016). The API sync (platform/oem-sync) and the CSV import both write through
 * `applyCoverage`.
 */

/** Up to `limit` of `vendor`'s fleet assets whose coverage is stale (domain/coverage `staleCoverageQuery`), longest unchecked first, by normalized serial (a serial can be shared by duplicate records). */
export function staleAssets(vendor: OemVendor, staleBefore: string, limit: number): Map<string, string[]> {
    const asset = new GlideRecord('alm_hardware')
    asset.addEncodedQuery(staleCoverageQuery(vendor, staleBefore))
    asset.orderBy(COVERAGE_CHECKED_FIELD)
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
export function applyCoverage(
    vendor: OemVendor,
    source: CoverageSource,
    answered: ReadonlyMap<string, string>,
    answers: readonly CoverageAnswer[],
    stamped: readonly string[],
): string[] {
    const checkedAt = nowGlide()
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
        asset.setValue(COVERAGE_CHECKED_FIELD, checkedAt)
        if (!asset.update()) refused.push(`${str(asset, 'serial_number')} not saved: ${refusal(asset)}`)
    }
    return refused
}

function failed(comment: string): RowOutcome {
    return { state: 'error', comment }
}

/**
 * Import a coverage row (vendors without an API): the coverage of a fleet asset's serial only. A row whose coverage
 * the platform refuses is marked error with why, to load again once the cause is fixed.
 */
export function importCoverageRow(row: GlideRecord): RowOutcome {
    const vendor = str(row, 'vendor') as OemVendor
    const serial = normalizeSerial(str(row, 'serial_number'))
    const start = str(row, 'start_date')
    const end = str(row, 'end_date')
    const cost = str(row, 'annual_cost').trim()
    if (!SYNC_ORDER.includes(vendor)) return failed(`vendor must be one of ${SYNC_ORDER.join(', ')}`)
    if (!serial) return failed('serial number is required')
    if ((start && !isIsoDate(start)) || (end && !isIsoDate(end))) return failed('dates must be real calendar dates (YYYY-MM-DD)')
    if (cost && !Number.isFinite(Number(cost))) return failed('annual cost must be a number')
    const asset = fleetAssetWithSerial(serial)
    if (!asset) return failed(`no fleet asset with serial ${serial}`)
    const assetId = asset.getUniqueValue()
    const fact: CoverageFact = {
        serial,
        covered: true,
        contractNumber: str(row, 'contract_number'),
        serviceLevel: str(row, 'service_level'),
        startDate: start || undefined,
        endDate: end || undefined,
    }
    const answer: CoverageAnswer = { assetId, fact, annualCost: cost ? Number(cost) : undefined }
    const refused = applyCoverage(vendor, 'csv', new Map([[assetId, serial]]), [answer], [])
    if (refused.length > 0) return failed(refused.join('; '))
    return { state: 'inserted', comment: `Coverage for ${serial}` }
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
