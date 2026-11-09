import { addMonths } from './calendar.ts'

/** Audits (blind counts, site audits) and Attestations (P2.7, D63). */

export interface ExpectedAsset {
    assetId: string
    serial: string
    providerTag: string
    customerTag: string
}

export interface AuditComparison {
    matched: string[]
    missing: string[]
    unexpected: string[]
}

const key = (code: string) => code.trim().toUpperCase()

/** The identifier fields of an expected Asset, in the order a scan is matched against them (domain/asset-identifier). */
const FIELDS = ['serial', 'providerTag', 'customerTag'] as const

/**
 * What was found, what is missing and which scans match nothing expected. A scan names the expected Asset whose serial
 * it is, else whose Provider tag, else whose Customer tag, as everywhere else a code is resolved (domain/asset-identifier):
 * a Customer tag never takes a scan from another unit's serial. A code that two expected Assets carry in the same field
 * names neither and is listed as unexpected, for a person to resolve, rather than marking one of them found by row order.
 */
export function compareAudit(expected: readonly ExpectedAsset[], scans: readonly string[]): AuditComparison {
    const byField = FIELDS.map((field) => {
        const index = new Map<string, string[]>()
        for (const asset of expected) {
            const code = asset[field] ? key(asset[field]) : ''
            if (code) index.set(code, [...(index.get(code) ?? []), asset.assetId])
        }
        return index
    })
    const named = (scan: string): string | undefined => {
        for (const index of byField) {
            const ids = index.get(key(scan))
            if (ids) return ids.length === 1 ? ids[0] : undefined
        }
        return undefined
    }
    const found = new Set<string>()
    const unexpected: string[] = []
    for (const scan of scans) {
        const assetId = named(scan)
        if (assetId) found.add(assetId)
        else unexpected.push(scan.trim())
    }
    return {
        matched: expected.filter((a) => found.has(a.assetId)).map((a) => a.assetId),
        missing: expected.filter((a) => !found.has(a.assetId)).map((a) => a.assetId),
        unexpected,
    }
}

export function attestationDue(input: { lastAttestedOn?: string; intervalMonths: number; today: string }): boolean {
    if (input.intervalMonths <= 0) return false
    if (!input.lastAttestedOn) return true
    return addMonths(input.lastAttestedOn, input.intervalMonths) <= input.today
}
