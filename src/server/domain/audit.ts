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

/** What was found, what is missing and which scans match nothing expected. */
export function compareAudit(expected: readonly ExpectedAsset[], scans: readonly string[]): AuditComparison {
    const byCode = new Map<string, string>()
    for (const asset of expected) {
        for (const code of [asset.serial, asset.providerTag, asset.customerTag]) if (code) byCode.set(key(code), asset.assetId)
    }
    const found = new Set<string>()
    const unexpected: string[] = []
    for (const scan of scans) {
        const assetId = byCode.get(key(scan))
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
