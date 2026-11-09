/**
 * A serial number as the app stores and compares it: trimmed, in upper case. A scanned code and a tag are compared the
 * same way (domain/audit), as a scan may be any of the three.
 */
export function normalizeSerial(serial: string): string {
    return serial.trim().toUpperCase()
}
