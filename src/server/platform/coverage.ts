import { GlideRecord } from '@servicenow/glide'
import { appendTo } from '../domain/collections.ts'
import {
    answersByContract,
    contractKey,
    COVERAGE_CHECKED_FIELD,
    COVERAGE_END_FIELD,
    coverageBySerial,
    mergeCoverage,
    staleCoverageQuery,
    type AssetCoverage,
    type CoverageAnswer,
    type SerialCoverage,
} from '../domain/coverage.ts'
import { FLEET_CONDITION } from '../domain/fleet.ts'
import { parseCoverageRow } from '../domain/oem/adapters.ts'
import type { CoverageFact } from '../domain/oem/types.ts'
import { normalizeSerial } from '../domain/serials.ts'
import type { CoverageSource, OemVendor } from '../domain/vocabulary.ts'
import { nowGlide, todayIso } from './clock.ts'
import { addAnyOf, bool, num, refusal, rowError, str, type RowOutcome } from './records.ts'

/**
 * OEM coverage as stored (P2.1): the contracts of each serial (x_daas_ham_oem_coverage) and their summary on the
 * Assets, of fleet assets only (ADR 0016). Every write of a contract is made here: the API sync (platform/oem-sync)
 * and the CSV import (`importCoverageRow`) both write through `applyCoverage`, and the mark that its expiry was warned
 * about is set (`markExpiryWarned`) and cleared (`setCoverage`, when its end date moves) here too.
 */

/** Up to `limit` of `vendor`'s fleet assets whose coverage is stale, longest unchecked first, by normalized serial (a serial can be shared by duplicate records). */
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

/** What a serial's vendor said: its contracts (none: not covered), or an error of its own, which only stamps it checked. */
export type SerialAnswer = { kind: 'apply'; facts: readonly CoverageFact[]; annualCost?: number } | { kind: 'stamp' }

/** One serial's coverage to write: the Assets carrying it, in the order staleAssets gives them, and its vendor's answer. */
export interface SerialWrite {
    assetIds: readonly string[]
    answer: SerialAnswer
}

/**
 * Serials match after normalisation. Returns the saves the platform refused: a serial whose coverage is refused
 * leaves its Assets unsummarised and unchecked, so it is asked again rather than summarised from contracts that were
 * not stored.
 */
export function applyCoverage(vendor: OemVendor, source: CoverageSource, writes: ReadonlyMap<string, SerialWrite>): string[] {
    const checkedAt = nowGlide()
    const bySerial = new Map([...writes].map(([serial, write]) => [normalizeSerial(serial), write]))
    const serials: string[] = []
    const answers: CoverageAnswer[] = []
    for (const [serial, { assetIds, answer }] of bySerial) {
        if (answer.kind !== 'apply') continue
        serials.push(serial)
        const assetId = assetIds[assetIds.length - 1] ?? ''
        for (const fact of answer.facts) answers.push({ assetId, fact, annualCost: answer.annualCost })
    }
    const { contracts, refused } = writeCoverage(vendor, source, serials, answers, checkedAt)
    const coverageOf = coverageBySerial(serials, contracts, todayIso())
    const assets = new Map<string, AssetCoverage | undefined>()
    for (const [serial, { assetIds }] of bySerial) {
        if (refused.has(serial)) continue
        for (const assetId of assetIds) assets.set(assetId, coverageOf.get(serial))
    }
    const unstamped = refreshAssetCoverage(assets, checkedAt)
    return [...[...refused].map(([serial, reason]) => `coverage of ${serial} not saved: ${reason}`), ...unstamped]
}

function writeCoverage(vendor: OemVendor, source: CoverageSource, serials: readonly string[], answers: readonly CoverageAnswer[], checkedAt: string): CoverageWrite {
    const contracts: SerialCoverage[] = []
    const refused = new Map<string, string>()
    if (serials.length === 0) return { contracts, refused }
    const refuse = (coverage: GlideRecord) => {
        const contract = str(coverage, 'contract_number')
        refused.set(normalizeSerial(str(coverage, 'serial_number')), `contract ${contract}: ${refusal(coverage)}`)
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
 * Mark the contract as warned about (platform/coverage-warnings sends the warning once per contract) and save it;
 * false when the platform refuses, so it is counted again at the next run. `setCoverage` clears the mark when the
 * contract's end date moves, so the new end is warned about too.
 */
export function markExpiryWarned(coverage: GlideRecord): boolean {
    coverage.setValue('expiry_notified', true)
    return !!coverage.update()
}

function refreshAssetCoverage(coverageOf: ReadonlyMap<string, AssetCoverage | undefined>, checkedAt: string): string[] {
    const refused: string[] = []
    if (coverageOf.size === 0) return refused
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('sys_id', 'IN', [...coverageOf.keys()].join(','))
    asset.query()
    while (asset.next()) {
        const coverage = coverageOf.get(asset.getUniqueValue())
        if (coverage) {
            asset.setValue(COVERAGE_END_FIELD, coverage.coverageEnd)
            asset.setValue('x_daas_ham_coverage_level', coverage.serviceLevel)
            asset.setValue('x_daas_ham_support_cost', coverage.supportCost)
        }
        asset.setValue(COVERAGE_CHECKED_FIELD, checkedAt)
        if (!asset.update()) refused.push(`${str(asset, 'serial_number')} not saved: ${refusal(asset)}`)
    }
    return refused
}

/**
 * Import a coverage row (vendors without an API): the coverage of a fleet asset's serial only. A row whose coverage
 * the platform refuses is marked error with why, to load again once the cause is fixed.
 */
export function importCoverageRow(row: GlideRecord): RowOutcome {
    const parsed = parseCoverageRow({
        vendor: str(row, 'vendor'),
        serial: str(row, 'serial_number'),
        contractNumber: str(row, 'contract_number'),
        serviceLevel: str(row, 'service_level'),
        startDate: str(row, 'start_date'),
        endDate: str(row, 'end_date'),
        annualCost: str(row, 'annual_cost'),
    })
    if (!parsed.ok) return rowError(parsed.reason)
    const { serial } = parsed.fact
    const assetIds = fleetAssetsWithSerial(serial)
    if (assetIds.length === 0) return rowError(`no fleet asset with serial ${serial}`)
    const answer: SerialAnswer = { kind: 'apply', facts: [parsed.fact], annualCost: parsed.annualCost }
    const refused = applyCoverage(parsed.vendor, 'csv', new Map([[serial, { assetIds, answer }]]))
    if (refused.length > 0) return rowError(refused.join('; '))
    return { state: 'inserted', comment: `Coverage for ${serial}` }
}

/** The fleet assets (ADR 0016) with this serial, in staleAssets' order: one of the Provider IT's that carries it is not covered here. */
function fleetAssetsWithSerial(serial: string): string[] {
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('serial_number', serial)
    asset.addEncodedQuery(FLEET_CONDITION)
    asset.orderBy(COVERAGE_CHECKED_FIELD)
    asset.query()
    const ids: string[] = []
    while (asset.next()) ids.push(asset.getUniqueValue())
    return ids
}
