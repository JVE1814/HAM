import { normalizeSerial } from './asn'
import type { CoverageFact, CoverageFetched } from './oem/types'

/** OEM coverage of one Asset, summarised from its coverage contracts. */
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
    for (const fact of result.facts) {
        const key = normalizeSerial(fact.serial)
        facts.set(key, [...(facts.get(key) ?? []), fact])
    }
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
