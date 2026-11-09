import { describe, expect, it } from 'vitest'
import { scanQueue } from './scan-queue'

/** A promise and the functions that settle it. */
function deferred() {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

/** Lets queued promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('scanQueue', () => {
    it('sends one scan at a time, in scan order, taking scans while one is being sent', async () => {
        const started: string[] = []
        const requests = new Map<string, ReturnType<typeof deferred>>()
        const pending: number[] = []
        const push = scanQueue(
            (code: string) => {
                started.push(code)
                const request = deferred()
                requests.set(code, request)
                return request.promise
            },
            (count) => pending.push(count),
        )

        push('A')
        push('B') // arrives while A is still being sent
        push('C')
        expect(started).toEqual(['A'])
        expect(pending).toEqual([1, 2, 3])

        requests.get('A')!.resolve()
        await settle()
        expect(started).toEqual(['A', 'B'])
        requests.get('B')!.resolve()
        await settle()
        requests.get('C')!.resolve()
        await settle()
        expect(started).toEqual(['A', 'B', 'C'])
        expect(pending).toEqual([1, 2, 3, 2, 1, 0])
    })

    it('goes on to the next scan when one fails', async () => {
        const started: string[] = []
        const push = scanQueue(async (code: string) => {
            started.push(code)
            if (code === 'bad') throw new Error('refused')
        })
        push('bad')
        push('good')
        await settle()
        expect(started).toEqual(['bad', 'good'])
    })

    it('starts again for a scan that arrives once the queue is empty', async () => {
        const started: string[] = []
        const push = scanQueue(async (code: string) => {
            started.push(code)
        })
        push('A')
        await settle()
        push('B')
        await settle()
        expect(started).toEqual(['A', 'B'])
    })

    it('keeps the context each scan was queued with', async () => {
        const sent: Array<{ code: string; order: string }> = []
        const first = deferred()
        let calls = 0
        const push = scanQueue((scan: { code: string; order: string }) => {
            sent.push(scan)
            return calls++ === 0 ? first.promise : Promise.resolve()
        })
        let order = 'NORD1'
        push({ code: 'A', order })
        order = 'NORD2' // changed while A is still being sent
        push({ code: 'B', order })
        first.resolve()
        await settle()
        expect(sent).toEqual([
            { code: 'A', order: 'NORD1' },
            { code: 'B', order: 'NORD2' },
        ])
    })
})
