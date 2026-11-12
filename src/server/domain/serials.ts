/**
 * A serial number as the app stores and compares it: trimmed, in upper case. Every identifier is compared the same way
 * (domain/asset-identifier), as a scan may be a serial or either tag.
 */
export function normalizeSerial(serial: string): string {
    return serial.trim().toUpperCase()
}
