/** One sent scan as the log shows it: the server's words. */
export interface Entry {
    id: number
    message: string
}

/** A scan that failed, kept with the context it was scanned in so it can be sent again as it was. */
export interface FailedScan<T> {
    id: number
    scan: T
    message: string
}

/**
 * What the page shows of the scans sent. `sent` is the newest scans that went through, cut at RECENT. `failed` is
 * never cut: a failed scan is a unit not received, picked or counted, and stays until the operator rescans or
 * dismisses it.
 */
export interface ScanLog<T> {
    next: number
    sent: readonly Entry[]
    failed: readonly FailedScan<T>[]
}

export type ScanLogAction<T> =
    | { type: 'sent'; message: string }
    | { type: 'failed'; scan: T; message: string }
    | { type: 'dismissed'; id: number }
    | { type: 'dismissedAll' }

export const RECENT = 50

export const EMPTY_LOG: ScanLog<never> = { next: 0, sent: [], failed: [] }

export function scanLog<T>(log: ScanLog<T>, action: ScanLogAction<T>): ScanLog<T> {
    switch (action.type) {
        case 'sent':
            return { ...log, next: log.next + 1, sent: [{ id: log.next, message: action.message }, ...log.sent].slice(0, RECENT) }
        case 'failed':
            return { ...log, next: log.next + 1, failed: [{ id: log.next, scan: action.scan, message: action.message }, ...log.failed] }
        case 'dismissed':
            return { ...log, failed: log.failed.filter((failure) => failure.id !== action.id) }
        case 'dismissedAll':
            return { ...log, failed: [] }
    }
}
