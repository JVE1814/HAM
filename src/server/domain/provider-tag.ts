/** Provider tags: the barcode identifiers printed at receiving, e.g. NAAS-0000042. */

export function formatProviderTag(prefix: string, sequence: number, digits: number): string {
    return `${prefix}-${String(sequence).padStart(digits, '0')}`
}

/**
 * The number to issue after the counter's `last`: the first one past it that is not `taken` (its tag on an Asset). A
 * counter set back, by a holder whose write outlasted its lock (ADR 0013), so skips the tags issued since it read.
 */
export function nextFreeSequence(last: number, taken: (sequence: number) => boolean): number {
    let next = last + 1
    while (taken(next)) next++
    return next
}
