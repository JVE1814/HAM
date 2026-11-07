/** ASN rows: a distributor's list of serials in transit against a purchase order. */

export interface AsnRow {
    serial: string
    pid: string
    poNumber: string
}

export type AsnRowCheck = { row: number; ok: true } | { row: number; ok: false; reason: string }

export function normalizeSerial(serial: string): string {
    return serial.trim().toUpperCase()
}

/**
 * The job lock (ADR 0013) the Asset of a serial not yet known is created under, by a first scan without an ASN and by
 * an ASN row alike, so the two create one Asset. A serial too long for a lock name (100 characters) shares its lock
 * with those it starts like.
 */
export function receiveSerialLockName(serial: string): string {
    return `receive_serial_${normalizeSerial(serial)}`.slice(0, 100)
}

/** Check each row; `knownSerials` holds normalized serials that already exist as Assets. */
export function validateAsnRows(rows: readonly AsnRow[], knownSerials: ReadonlySet<string>): AsnRowCheck[] {
    const seen = new Set<string>()
    return rows.map((row, index) => {
        const serial = normalizeSerial(row.serial)
        if (!serial) return { row: index, ok: false, reason: 'serial is required' }
        if (!row.pid.trim()) return { row: index, ok: false, reason: 'PID is required' }
        if (!row.poNumber.trim()) return { row: index, ok: false, reason: 'purchase order is required' }
        if (seen.has(serial)) return { row: index, ok: false, reason: `serial ${serial} appears more than once in this ASN` }
        seen.add(serial)
        if (knownSerials.has(serial)) return { row: index, ok: false, reason: `serial ${serial} already exists` }
        return { row: index, ok: true }
    })
}
