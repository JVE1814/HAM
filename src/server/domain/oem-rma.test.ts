import { describe, expect, it } from 'vitest'
import { advanceReplacementRma, OPEN_RMAS_QUERY, type OpenRma, RMA_AT_OEM, RMA_OPEN } from './oem-rma'
import { RMA_STATE } from './vocabulary'
import { recordMatches as matches } from '../test-support/encoded-query'

describe('advanceReplacementRma', () => {
    const rma = (rma: Partial<OpenRma> & Pick<OpenRma, 'rmaId'>): OpenRma => ({
        rmaNumber: '',
        state: 'to_open',
        lineId: '',
        lineOpen: false,
        ...rma,
    })

    it('opens a new RMA when none is open for the unit the line replaces', () => {
        expect(advanceReplacementRma('line-1', [])).toBeNull()
        const returned = rma({ rmaId: 'r1', state: 'defective_returned', lineId: 'line-1', lineOpen: true })
        const done = [returned, rma({ rmaId: 'r2', state: 'closed' })]
        expect(advanceReplacementRma('line-1', done)).toBeNull()
    })

    it("reuses the line's own RMA whose replacement was lost in transit, open again to ask for another", () => {
        const received = rma({ rmaId: 'r1', state: 'replacement_received', lineId: 'line-1', lineOpen: true })
        expect(advanceReplacementRma('line-1', [received])).toEqual({ rma: received, state: 'open', askAgain: true })
    })

    it('reuses an RMA whose replacement is still to come as it is, the line waiting for that replacement', () => {
        for (const state of ['to_open', 'open'] as const) {
            const awaited = rma({ rmaId: 'r1', state })
            expect(advanceReplacementRma('line-1', [awaited])).toEqual({ rma: awaited, state, askAgain: false })
        }
    })

    it('reuses one left by a line no longer waiting for it, such as a cancelled Order', () => {
        const left = rma({ rmaId: 'r1', state: 'open', lineId: 'line-0', lineOpen: false })
        expect(advanceReplacementRma('line-1', [left])?.rma).toBe(left)
    })

    it('leaves an RMA another open line waits for to that line', () => {
        const theirs = rma({ rmaId: 'r1', state: 'open', lineId: 'line-2', lineOpen: true })
        expect(advanceReplacementRma('line-1', [theirs])).toBeNull()
    })

    it("prefers the line's own RMA, then one whose replacement is still to come", () => {
        const stray = rma({ rmaId: 'stray', state: 'replacement_received' })
        const awaited = rma({ rmaId: 'awaited', state: 'to_open' })
        const own = rma({ rmaId: 'own', state: 'replacement_received', lineId: 'line-1', lineOpen: true })
        expect(advanceReplacementRma('line-1', [stray, awaited, own])?.rma).toBe(own)
        expect(advanceReplacementRma('line-1', [stray, awaited])?.rma).toBe(awaited)
    })

    it('takes the oldest of RMAs ranked alike (the platform lists them oldest first)', () => {
        const older = rma({ rmaId: 'older', state: 'open' })
        const newer = rma({ rmaId: 'newer', state: 'to_open' })
        expect(advanceReplacementRma('line-1', [older, newer])?.rma).toBe(older)
        expect(advanceReplacementRma('line-1', [newer, older])?.rma).toBe(newer)
    })
})

describe('the open RMAs', () => {
    it('are the ones the query the metadata imports selects', () => {
        for (const state of Object.values(RMA_STATE)) expect(matches(OPEN_RMAS_QUERY, { state }), state).toBe(RMA_OPEN.includes(state))
    })

    it('are with the OEM once opened there: all but those still to open', () => {
        expect(RMA_AT_OEM).toEqual(['open', 'replacement_received'])
    })
})
