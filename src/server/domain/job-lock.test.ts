import { describe, expect, it } from 'vitest'
import {
    ABANDONED_AFTER_MINUTES,
    attemptUnderLock,
    REQUEUE,
    TRY_AGAIN,
    writeHoldingLock,
    type HeldLock,
    type LockPorts,
} from './job-lock'

/**
 * Lock rows in memory. `takes` scripts each take in turn ('free' once they run out): the lock is free, another holder
 * has it, or the take throws. `lose()` clears the lock from its holder, as a taker that judged it abandoned does.
 */
function lockRows(takes: Array<'free' | 'held' | 'throws'> = []) {
    const log: string[] = []
    const taken: string[] = []
    const released: string[] = []
    const rows = new Set<string>()
    let attempts = 0
    const ports: LockPorts = {
        take: (name) => {
            const take = takes[attempts++] ?? 'free'
            if (take === 'throws') throw new Error(`job lock ${name} could not be taken: take ${attempts}`)
            if (take === 'held') return null
            const id = `${name}#${attempts}`
            taken.push(id)
            rows.add(id)
            return id
        },
        release: (lockId) => {
            released.push(lockId)
            rows.delete(lockId)
        },
        held: (lockId) => rows.has(lockId),
        log: (level, message) => log.push(`${level}: ${message}`),
    }
    return { ports, log, taken, released, lose: () => rows.clear(), attempts: () => attempts }
}

describe('the numbers the retries share', () => {
    it('queue a request again for longer than a lock takes to count as abandoned', () => {
        expect(REQUEUE.times * REQUEUE.delaySeconds).toBeGreaterThan(ABANDONED_AFTER_MINUTES * 60)
    })
})

describe('attemptUnderLock', () => {
    it('runs the work holding the lock, gives what it returned and releases the lock', () => {
        const rows = lockRows()
        let heldInside = false
        const attempt = attemptUnderLock(rows.ports, 'order_line_a', 1, (lock) => {
            heldInside = lock.held()
            return 42
        })
        expect(attempt).toEqual({ ran: true, value: 42 })
        expect(heldInside).toBe(true)
        expect(rows.released).toEqual(rows.taken)
    })

    it('gives a falsy value the work returned as its value, not as a try given up', () => {
        const rows = lockRows()
        expect(attemptUnderLock(rows.ports, 'l', 3, () => false)).toEqual({ ran: true, value: false })
        expect(attemptUnderLock(rows.ports, 'l', 3, () => null)).toEqual({ ran: true, value: null })
        expect(attemptUnderLock(rows.ports, 'l', 3, () => undefined)).toEqual({ ran: true, value: undefined })
        expect(rows.attempts()).toBe(3)
    })

    it('does not run the work while another holder has the lock, and tries no more often than asked', () => {
        const rows = lockRows(['held', 'held', 'held', 'held'])
        let ran = 0
        expect(attemptUnderLock(rows.ports, 'l', 3, () => ran++)).toEqual({ ran: false, held: true })
        expect(ran).toBe(0)
        expect(rows.attempts()).toBe(3)
    })

    it('runs the work once the holder lets go', () => {
        const rows = lockRows(['held', 'held', 'free'])
        expect(attemptUnderLock(rows.ports, 'l', 5, () => 'done')).toEqual({ ran: true, value: 'done' })
        expect(rows.attempts()).toBe(3)
    })

    it('tries a take that throws again', () => {
        const rows = lockRows(['throws', 'free'])
        expect(attemptUnderLock(rows.ports, 'l', 5, () => 'done')).toEqual({ ran: true, value: 'done' })
    })

    it('reports a lock that could not be taken only when no try found it held, with what the last take threw', () => {
        const threw = attemptUnderLock(lockRows(['throws', 'throws']).ports, 'l', 2, () => 'done')
        expect(threw).toMatchObject({ ran: false, held: false })
        expect(threw.ran || threw.held || threw.error).toEqual(new Error('job lock l could not be taken: take 2'))
        expect(attemptUnderLock(lockRows(['throws', 'held']).ports, 'l', 2, () => 'done')).toEqual({ ran: false, held: true })
        expect(attemptUnderLock(lockRows(['held', 'throws']).ports, 'l', 2, () => 'done')).toEqual({ ran: false, held: true })
    })

    it("lets the work's own error escape at once, the lock released and not taken again", () => {
        const rows = lockRows()
        const work = () => {
            throw new Error('insert refused')
        }
        expect(() => attemptUnderLock(rows.ports, 'l', 5, work)).toThrow('insert refused')
        expect(rows.attempts()).toBe(1)
        expect(rows.released).toEqual(rows.taken)
    })

    it('runs the work again after it gave its try up, each time under a lock taken afresh', () => {
        const rows = lockRows()
        let runs = 0
        const attempt = attemptUnderLock(rows.ports, 'l', 5, () => (++runs < 3 ? TRY_AGAIN : runs))
        expect(attempt).toEqual({ ran: true, value: 3 })
        expect(rows.taken).toHaveLength(3)
        expect(rows.released).toEqual(rows.taken)
    })

    it('counts work that gave every try up as a lock held through every try', () => {
        const rows = lockRows()
        expect(attemptUnderLock(rows.ports, 'l', 2, () => TRY_AGAIN)).toEqual({ ran: false, held: true })
        expect(rows.attempts()).toBe(2)
    })
})

/** Run `work` with a held lock whose rows the test can clear. */
function holding<T>(work: (lock: HeldLock, rows: ReturnType<typeof lockRows>) => T): { value: T; log: string[] } {
    const rows = lockRows()
    const attempt = attemptUnderLock(rows.ports, 'order_line_a', 1, (lock) => work(lock, rows))
    if (!attempt.ran) throw new Error('the lock was free')
    return { value: attempt.value as T, log: rows.log }
}

describe('HeldLock.write', () => {
    it('makes the write while the lock is held and gives what it returned', () => {
        const { value } = holding((lock) => lock.write(() => 'sys_id'))
        expect(value).toEqual({ written: true, value: 'sys_id', lockLost: false })
    })

    it('does not make the write once the lock is lost', () => {
        let written = false
        const { value } = holding((lock, rows) => {
            rows.lose()
            return lock.write(() => (written = true))
        })
        expect(value).toEqual({ written: false })
        expect(written).toBe(false)
    })

    it('says so when the lock was lost while the write ran', () => {
        const { value, log } = holding((lock, rows) =>
            lock.write(() => {
                rows.lose()
                return 'sys_id'
            }),
        )
        expect(value).toEqual({ written: true, value: 'sys_id', lockLost: true })
        expect(log).toEqual([])
    })

    it.each([false, true])('lets what the write throws escape (lock lost meanwhile: %s)', (lost) => {
        const work = (lock: HeldLock, rows: ReturnType<typeof lockRows>) =>
            lock.write(() => {
                if (lost) rows.lose()
                throw new Error('counter could not be saved')
            })
        expect(() => holding(work)).toThrow('counter could not be saved')
    })
})

describe('HeldLock.save', () => {
    it('saves while the lock is held', () => {
        const { value, log } = holding((lock) => lock.save('L1 saved', () => 'sys_id'))
        expect(value).toBe('saved')
        expect(log).toEqual([])
    })

    it('saves nothing once the lock is lost', () => {
        let saved = false
        const { value, log } = holding((lock, rows) => {
            rows.lose()
            return lock.save('L1 saved', () => (saved = true))
        })
        expect(value).toBe('lock lost')
        expect(saved).toBe(false)
        expect(log).toEqual([])
    })

    it('reports a save the platform refused, without a word about the lock', () => {
        const { value, log } = holding((lock, rows) =>
            lock.save('L1 saved', () => {
                rows.lose()
                return null
            }),
        )
        expect(value).toBe('refused')
        expect(log).toEqual([])
    })

    it('logs a save made while the lock was lost, with what was saved, the lock and what to check', () => {
        const save = (lock: HeldLock, rows: ReturnType<typeof lockRows>) =>
            lock.save(
                'L1 saved',
                () => {
                    rows.lose()
                    return 'sys_id'
                },
                { check: 'check its On order count' },
            )
        const { value, log } = holding(save)
        expect(value).toBe('saved')
        expect(log).toEqual(['warn: L1 saved after its lock order_line_a was lost: check its On order count'])
    })

    it('logs it as an error where asked, and says what to check when the caller does not', () => {
        const late = (lock: HeldLock, rows: ReturnType<typeof lockRows>) =>
            lock.save(
                'L1 saved',
                () => {
                    rows.lose()
                    return 'sys_id'
                },
                { level: 'error' },
            )
        expect(holding(late).log).toEqual([
            'error: L1 saved after its lock order_line_a was lost: check what the holder that took it over did meanwhile',
        ])
    })
})

describe('HeldLock.lostAfter', () => {
    it('says nothing while the lock is held', () => {
        const { value, log } = holding((lock) => lock.lostAfter('ORD1 cancelled', { check: 'check its lines' }))
        expect(value).toBe(false)
        expect(log).toEqual([])
    })

    it('logs what was saved after the lock was lost', () => {
        const { value, log } = holding((lock, rows) => {
            rows.lose()
            return lock.lostAfter('ORD1 cancelled', { check: 'check its lines' })
        })
        expect(value).toBe(true)
        expect(log).toEqual(['warn: ORD1 cancelled after its lock order_line_a was lost: check its lines'])
    })
})

describe('writeHoldingLock', () => {
    it('gives what a write returned that held the lock throughout', () => {
        expect(writeHoldingLock(() => true, () => 7)).toEqual({ lock: 'held', value: 7 })
    })

    it('reports a write that finished after losing the lock', () => {
        let held = true
        const write = () => {
            held = false
            return 7
        }
        expect(writeHoldingLock(() => held, write)).toEqual({ lock: 'lost', threw: false, value: 7 })
    })

    it('reports a write that threw after losing the lock, with what it threw', () => {
        let held = true
        const write = () => {
            held = false
            throw 'deadlock'
        }
        expect(writeHoldingLock(() => held, write)).toEqual({ lock: 'lost', threw: true, error: 'deadlock' })
    })

    it('throws on from a write that threw still holding the lock', () => {
        expect(() =>
            writeHoldingLock(
                () => true,
                () => {
                    throw new Error('insert refused')
                },
            ),
        ).toThrow('insert refused')
    })
})
