import { appendTo } from './collections.ts'
import { FLEET_CONDITION, fleetCondition, INSTALLED_CONDITION } from './fleet.ts'
import { notRetiredCondition } from './lifecycle.ts'
import type { CoverageFact, CoverageFetched } from './oem/types.ts'
import { normalizeSerial } from './serials.ts'
import type { OemVendor } from './vocabulary.ts'

/** One coverage contract, as an Asset's coverage is summarised from it. */
export interface CoverageView {
    covered: boolean
    endDate?: string
    serviceLevel: string
    /** What the Provider pays the OEM per year for this contract. */
    annualCost?: number
}

export interface CoverageSummary {
    coveredToday: boolean
    coverageEnd: string
    serviceLevel: string
}

export function coverageSummary(contracts: readonly CoverageView[], today: string): CoverageSummary {
    const latest = contracts
        .filter((c) => c.covered && c.endDate)
        .sort((a, b) => (b.endDate ?? '').localeCompare(a.endDate ?? ''))[0]
    if (!latest?.endDate) return { coveredToday: false, coverageEnd: '', serviceLevel: '' }
    return { coveredToday: latest.endDate >= today, coverageEnd: latest.endDate, serviceLevel: latest.serviceLevel }
}

/** What the Provider pays per year for the contracts covering an Asset today. */
export function annualSupportCost(contracts: readonly CoverageView[], today: string): number {
    return contracts.filter((c) => c.covered && (!c.endDate || c.endDate >= today)).reduce((sum, c) => sum + (c.annualCost ?? 0), 0)
}

/** What the coverage sync does with one asked serial once its vendor has been called. */
export type CoverageDisposition =
    /** Answered: write these contracts (none: not covered) and re-summarise the Asset onto it. */
    | { kind: 'apply'; facts: CoverageFact[] }
    /** Answered with an error of the vendor's own: keep the coverage and stamp it checked, so it is asked again only after the refresh interval. */
    | { kind: 'stamp' }
    /** The call failed, so nothing is known: leave it stale for the next run. */
    | { kind: 'skip' }

/** The disposition of each asked serial in a coverage answer, matching serials after normalisation. */
export function coverageDisposition(result: CoverageFetched): (serial: string) => CoverageDisposition {
    const failed = new Set(result.failed.map(normalizeSerial))
    const rejected = new Set(result.rejected.map(normalizeSerial))
    const facts = new Map<string, CoverageFact[]>()
    for (const fact of result.facts) appendTo(facts, normalizeSerial(fact.serial), fact)
    return (serial) => {
        const key = normalizeSerial(serial)
        if (failed.has(key)) return { kind: 'skip' }
        if (rejected.has(key)) return { kind: 'stamp' }
        return { kind: 'apply', facts: facts.get(key) ?? [] }
    }
}

/** A coverage contract's dates (YYYY-MM-DD) as stored or as answered; absent means none or unknown. */
export interface CoverageDates {
    startDate?: string
    endDate?: string
}

/** The values to write to a coverage contract on a fresh answer. */
export interface CoverageWrite extends CoverageDates {
    /** The end date changed: a renewed contract can expire again, so its expiry warning is to be sent afresh. */
    resetExpiryNotified: boolean
}

/** Combine a stored coverage contract (empty when new) with a fresh answer from the OEM API or a CSV import. */
export function mergeCoverage(stored: CoverageDates, incoming: CoverageDates): CoverageWrite {
    return {
        // A response without a start date (SN2INFO v2) keeps the one stored earlier.
        startDate: incoming.startDate ?? stored.startDate,
        endDate: incoming.endDate,
        resetExpiryNotified: (stored.endDate ?? '') !== (incoming.endDate ?? ''),
    }
}

/** One answered contract to write onto the coverage record of its serial and contract number. */
export interface CoverageAnswer {
    /** The Asset the record points at: of duplicate Assets sharing the serial, the last answered. */
    assetId: string
    fact: CoverageFact
    /** What the Provider pays the OEM per year; only a CSV import row gives it. */
    annualCost?: number
}

/** A coverage contract's identity: its serial and contract number, ignoring case as the database's own match does. */
export function contractKey(serial: string, contractNumber: string): string {
    return `${normalizeSerial(serial)}\n${contractNumber}`.toLowerCase()
}

/** The answers for each contract (by contractKey), in answer order, so that each contract's record is written once. */
export function answersByContract(answers: readonly CoverageAnswer[]): Map<string, CoverageAnswer[]> {
    const byContract = new Map<string, CoverageAnswer[]>()
    for (const answer of answers) appendTo(byContract, contractKey(answer.fact.serial, answer.fact.contractNumber), answer)
    return byContract
}

/** A stored coverage contract and the serial it covers. */
export interface SerialCoverage extends CoverageView {
    serial: string
}

/** The coverage an Asset is given: the summary of its serial's contracts and what the Provider pays for them per year. */
export interface AssetCoverage extends CoverageSummary {
    supportCost: number
}

/**
 * The coverage of each of `serials`, by normalised serial, summarised from the stored contracts whose serial
 * matches after normalisation; a serial without contracts gets an empty summary and no support cost, so its Assets
 * are cleared. Duplicate Assets sharing a serial share it.
 */
export function coverageBySerial(serials: Iterable<string>, contracts: readonly SerialCoverage[], today: string): Map<string, AssetCoverage> {
    const contractsOf = new Map<string, CoverageView[]>()
    for (const contract of contracts) appendTo(contractsOf, normalizeSerial(contract.serial), contract)
    const coverage = new Map<string, AssetCoverage>()
    for (const serial of serials) {
        const key = normalizeSerial(serial)
        const views = contractsOf.get(key) ?? []
        coverage.set(key, { ...coverageSummary(views, today), supportCost: annualSupportCost(views, today) })
    }
    return coverage
}

/** A coverage contract about to end, and the Customer whose equipment it covers. */
export interface ExpiringCoverage {
    customerId: string
    endDate: string
}

/** Expiring coverage per Customer: how many contracts, and the first one to end. */
export function groupExpiringCoverage(rows: readonly ExpiringCoverage[]): Map<string, { count: number; firstEnd: string }> {
    const groups = new Map<string, { count: number; firstEnd: string }>()
    for (const row of rows) {
        const group = groups.get(row.customerId)
        if (!group) groups.set(row.customerId, { count: 1, firstEnd: row.endDate })
        else groups.set(row.customerId, { count: group.count + 1, firstEnd: row.endDate < group.firstEnd ? row.endDate : group.firstEnd })
    }
    return groups
}

/** The Asset field that holds when its OEM coverage was last checked. */
export const COVERAGE_CHECKED_FIELD = 'x_daas_ham_coverage_checked'

/**
 * Encoded alm_hardware query: `vendor`'s fleet assets (ADR 0016: the Provider IT's serials are never sent to an OEM)
 * whose coverage is to be asked again: not retired, with a serial, and never checked or last checked before
 * `staleBefore` (a stored date/time).
 */
export function staleCoverageQuery(vendor: OemVendor, staleBefore: string): string {
    const stale = `${COVERAGE_CHECKED_FIELD}ISEMPTY^OR${COVERAGE_CHECKED_FIELD}<${staleBefore}`
    return `${fleetCondition()}^model.x_daas_ham_oem_source=${vendor}^${notRetiredCondition()}^serial_numberISNOTEMPTY^${stale}`
}

/**
 * Encoded query on alm_hardware: the installed fleet assets (ADR 0016) without OEM coverage, missing or ended before
 * today, as the workspace lists and counts them.
 */
export const INSTALLED_WITHOUT_COVERAGE = `${INSTALLED_CONDITION}^x_daas_ham_coverage_endISEMPTY^ORx_daas_ham_coverage_end<javascript:gs.beginningOfToday()^${FLEET_CONDITION}`
