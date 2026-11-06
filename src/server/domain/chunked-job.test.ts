import { describe, expect, it } from 'vitest'
import { runChunked, type ChunkedJobPorts } from './chunked-job'

function fakePorts(keys: string[], opts: { cursor?: string; tickMs?: number; failOn?: string[] } = {}) {
    let clock = 0
    const handled: string[] = []
    const saved: Array<{ cursor: string; processed: number; done: boolean }> = []
    const ports: ChunkedJobPorts<string> = {
        loadCursor: () => opts.cursor ?? '',
        fetchBatch: (after, size) => keys.filter((k) => k > after).slice(0, size),
        keyOf: (k) => k,
        handle: (k) => {
            clock += opts.tickMs ?? 1
            if (opts.failOn?.includes(k)) throw new Error(`boom ${k}`)
            handled.push(k)
        },
        saveCursor: (cursor, processed, done) => saved.push({ cursor, processed, done }),
        now: () => clock,
    }
    return { ports, handled, saved }
}

describe('runChunked', () => {
    it('processes every record in key order across batches and resets the cursor when done', () => {
        const { ports, handled, saved } = fakePorts(['a', 'b', 'c', 'd', 'e'])
        const result = runChunked(ports, { batchSize: 2, budgetMs: 1000 })
        expect(handled).toEqual(['a', 'b', 'c', 'd', 'e'])
        expect(result).toEqual({ processed: 5, failed: 0, done: true, cursor: '', lastError: '' })
        expect(saved.at(-1)).toEqual({ cursor: '', processed: 5, done: true })
    })

    it('stops when the time budget runs out and remembers where it stopped', () => {
        const { ports, handled } = fakePorts(['a', 'b', 'c', 'd'], { tickMs: 10 })
        const result = runChunked(ports, { batchSize: 10, budgetMs: 25 })
        expect(handled).toEqual(['a', 'b', 'c'])
        expect(result.done).toBe(false)
        expect(result.cursor).toBe('c')
    })

    it('resumes after the saved cursor', () => {
        const { ports, handled } = fakePorts(['a', 'b', 'c'], { cursor: 'a' })
        runChunked(ports, { batchSize: 10, budgetMs: 100 })
        expect(handled).toEqual(['b', 'c'])
    })

    it('keeps going past a failing record and reports it', () => {
        const { ports, handled } = fakePorts(['a', 'b', 'c'], { failOn: ['b'] })
        const result = runChunked(ports, { batchSize: 10, budgetMs: 100 })
        expect(handled).toEqual(['a', 'c'])
        expect(result.failed).toBe(1)
        expect(result.lastError).toBe('b: boom b')
    })
})
