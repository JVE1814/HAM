/** OEM coverage of one Asset, summarised from its coverage contracts. */
export interface CoverageView {
    covered: boolean
    endDate?: string
    serviceLevel: string
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
