/** Provider tags: the barcode identifiers printed at receiving, e.g. NAAS-0000042. */

export function formatProviderTag(prefix: string, sequence: number, digits: number): string {
    return `${prefix}-${String(sequence).padStart(digits, '0')}`
}

export function isProviderTag(code: string, prefix: string): boolean {
    return new RegExp(`^${prefix.replace(/[^A-Za-z0-9]/g, '')}-\\d+$`).test(code.trim())
}
