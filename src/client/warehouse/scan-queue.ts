/**
 * Sends scans one at a time, in the order they were scanned. The scan field never waits for the server: a
 * keyboard-wedge scanner types its next code whenever the operator pulls the trigger, and a field disabled while a
 * request runs drops the first characters of a code that arrives mid-request. Each scan carries the context it was
 * scanned in (mode, stockroom, order...), so a change made while scans wait applies only to later ones.
 *
 * Returns the function that queues a scan. `run` reports its own outcome; a run that throws still lets the next scan
 * go. `onPending` hears how many scans are queued or being sent, after each change.
 */
export function scanQueue<T>(run: (scan: T) => Promise<void>, onPending: (pending: number) => void = () => {}): (scan: T) => void {
    const waiting: T[] = []
    let sending = false

    const drain = async () => {
        sending = true
        while (waiting.length > 0) {
            try {
                await run(waiting[0])
            } catch {
                // `run` reports its own failures; the next scan still goes.
            }
            waiting.shift()
            onPending(waiting.length)
        }
        sending = false
    }

    return (scan) => {
        waiting.push(scan)
        onPending(waiting.length)
        if (!sending) void drain()
    }
}
