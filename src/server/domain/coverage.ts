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
