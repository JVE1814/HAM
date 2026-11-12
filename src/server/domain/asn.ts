import { normalizeSerial } from './serials.ts'

/** An ASN row: a serial a distributor has in transit against a purchase order. */
export interface AsnRow {
    serial: string
    pid: string
    poNumber: string
}

/** Why the row cannot be imported, or null. `serialKnown` says an Asset already has the row's serial. */
export function asnRowProblem(row: AsnRow, serialKnown: boolean): string | null {
    const serial = normalizeSerial(row.serial)
    if (!serial) return 'serial is required'
    if (!row.pid.trim()) return 'PID is required'
    if (!row.poNumber.trim()) return 'purchase order is required'
    if (serialKnown) return `serial ${serial} already exists`
    return null
}
