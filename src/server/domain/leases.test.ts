import { describe, expect, it } from 'vitest'
import {
    buyoutCost,
    buyoutPurchase,
    buyoutSplit,
    buyoutTerms,
    decidedLease,
    earliestReviewedEnd,
    evenShare,
    evenSplit,
    leaseDecisionProblem,
    leaseMismatch,
    stillCovered,
    stockReturnMoves,
} from './leases'
import { ALL_STAGES, checkTransition, type TransitionFacts } from './lifecycle'

describe('earliestReviewedEnd', () => {
    it('keeps reviewing an undecided lease for 30 days past its end', () => {
        expect(earliestReviewedEnd('2026-11-09')).toBe('2026-10-10')
    })
})

describe('decidedLease', () => {
    it('records a buy out or a return as the end action, and nothing else', () => {
        expect(decidedLease('buyout', '')).toEqual({ endAction: 'buyout' })
        expect(decidedLease('return', '2027-01-01')).toEqual({ endAction: 'return' })
    })

    it('moves an extended lease to its new end, undecided and with its mismatch cleared', () => {
        expect(decidedLease('extend', '2027-06-30')).toEqual({ endAction: 'undecided', ends: '2027-06-30', mismatch: false })
    })
})

describe('buyoutTerms', () => {
    it('fixes the covered count and the split of the price to the cent when a buyout is first applied', () => {
        const four = () => ['a4', 'a2', 'a3', 'a1']
        expect(buyoutTerms('buyout', { fixedAssets: 0, price: 1000 }, four)).toEqual({ assets: 4, share: 250, extraThrough: '' })
        expect(buyoutTerms('buyout', { fixedAssets: 0, price: 0 }, four)).toEqual({ assets: 4, share: 0, extraThrough: '' })
        expect(buyoutTerms('buyout', { fixedAssets: 0, price: 1000 }, () => [])).toEqual({ assets: 0, share: 0, extraThrough: '' })
        // 10000.00 over 3 leaves one cent, which the first Asset by sys_id takes.
        expect(buyoutTerms('buyout', { fixedAssets: 0, price: 10000 }, () => ['a3', 'a1', 'a2'])).toEqual({ assets: 3, share: 3333.33, extraThrough: 'a1' })
    })

    it('keeps terms already fixed, without counting the Assets again', () => {
        const counted = () => {
            throw new Error('counted')
        }
        expect(buyoutTerms('buyout', { fixedAssets: 4, price: 1000 }, counted)).toBeNull()
    })

    it('fixes none for any other decision', () => {
        expect(buyoutTerms('return', { fixedAssets: 0, price: 1000 }, () => ['a1'])).toBeNull()
        expect(buyoutTerms('extend', { fixedAssets: 0, price: 1000 }, () => ['a1'])).toBeNull()
    })
})

describe('leaseMismatch', () => {
    it('flags service that outlives the lease, including open-ended agreements', () => {
        expect(leaseMismatch('2027-06-30', ['2027-01-01', '2028-01-01'])).toBe(true)
        expect(leaseMismatch('2027-06-30', [''])).toBe(true)
    })

    it('accepts service that ends on or before the lease end', () => {
        expect(leaseMismatch('2027-06-30', ['2027-06-30', '2026-12-31'])).toBe(false)
        expect(leaseMismatch('2027-06-30', [])).toBe(false)
    })

    it('ignores leases without an end date', () => {
        expect(leaseMismatch('', [''])).toBe(false)
    })
})

describe('leaseDecisionProblem', () => {
    const undecided = { endAction: 'undecided', leaseEnd: '2027-06-30', newEndDate: '' } as const

    it('requires a decision', () => {
        expect(leaseDecisionProblem({ ...undecided, decision: '' })).toMatch(/Choose/)
        expect(leaseDecisionProblem({ ...undecided, decision: 'undecided' })).toMatch(/Choose/)
    })

    it('requires an extension to move the end date out', () => {
        const extend = { ...undecided, decision: 'extend' } as const
        expect(leaseDecisionProblem({ ...extend, newEndDate: '2027-06-30' })).toMatch(/new end date/)
        expect(leaseDecisionProblem({ ...extend, newEndDate: '2028-06-30' })).toBeNull()
    })

    it('accepts buyout and return as they are', () => {
        expect(leaseDecisionProblem({ ...undecided, decision: 'buyout' })).toBeNull()
        expect(leaseDecisionProblem({ ...undecided, decision: 'return' })).toBeNull()
    })

    it('treats a blank end action as undecided, and a lease extended before as open to a new decision', () => {
        expect(leaseDecisionProblem({ ...undecided, endAction: '', decision: 'return' })).toBeNull()
        expect(leaseDecisionProblem({ ...undecided, endAction: 'extend', decision: 'buyout' })).toBeNull()
    })

    it('refuses any further decision on a lease being bought out or returned', () => {
        for (const decision of ['buyout', 'extend', 'return'] as const) {
            const input = { ...undecided, decision, newEndDate: '2028-06-30' }
            expect(leaseDecisionProblem({ ...input, endAction: 'return' })).toMatch(/already being returned/)
            expect(leaseDecisionProblem({ ...input, endAction: 'buyout' })).toMatch(/already being bought out/)
        }
    })
})

describe('stillCovered', () => {
    it('leaves retired units, which keep their lease as history, out of what the lease covers', () => {
        expect(stillCovered('x_daas_ham_lease=L1')).toBe('x_daas_ham_lease=L1^install_status!=7^x_daas_ham_fleet=true')
        const bought = 'x_daas_ham_lease.end_action=buyout'
        expect(stillCovered(bought)).toBe(`${bought}^install_status!=7^x_daas_ham_fleet=true`)
    })

    it('covers fleet assets only (ADR 0016)', () => {
        expect(stillCovered('x_daas_ham_lease=L1').split('^')).toContain('x_daas_ham_fleet=true')
    })
})

describe('stockReturnMoves', () => {
    const lessorOwned: TransitionFacts = {
        hasSite: false,
        hasAgreement: false,
        legalOwner: 'lessor',
        wipeEvidenceComplete: false,
    }

    it('takes free stock to pending wipe, and spare-pool stock there through available', () => {
        expect(stockReturnMoves('available')).toEqual(['pending_wipe'])
        expect(stockReturnMoves('spare_pool')).toEqual(['available', 'pending_wipe'])
    })

    it('moves nothing that is not stock', () => {
        expect(stockReturnMoves('in_service')).toEqual([])
        expect(stockReturnMoves('reserved')).toEqual([])
        expect(stockReturnMoves(null)).toEqual([])
    })

    it('only makes moves the lifecycle allows, one save at a time', () => {
        for (const from of ALL_STAGES) {
            let stage = from
            for (const to of stockReturnMoves(from)) {
                expect(checkTransition(stage, to, lessorOwned), `${stage} -> ${to}`).toEqual({ allowed: true })
                stage = to
            }
        }
    })
})

describe('buyoutPurchase', () => {
    it('buys the Asset at its share of the buyout price on the buyout day', () => {
        expect(buyoutPurchase(3000, '2026-11-07')).toEqual({ cost: 3000, date: '2026-11-07' })
    })

    it('records no purchase without a buyout price, so the Asset keeps its cost and purchase date', () => {
        expect(buyoutPurchase(0, '2026-11-07')).toBeUndefined()
    })
})

describe('evenShare', () => {
    it("splits an amount evenly, unrounded, e.g. a lease payment's share for Margin", () => {
        expect(evenShare(9000, 3)).toBe(3000)
        expect(evenShare(0, 3)).toBe(0)
        expect(evenShare(10000, 3) * 3).toBeCloseTo(10000, 9)
    })

    it('gives no share when there is none to split it over', () => {
        expect(evenShare(9000, 0)).toBe(0)
    })
})

describe('evenSplit', () => {
    /** The shares an amount split by evenSplit gives, the first `extra` one cent more. */
    function shares(amount: number, count: number): number[] {
        const split = evenSplit(amount, count)
        return Array.from({ length: count }, (_, i) => (i < split.extra ? Math.round(split.share * 100 + 1) / 100 : split.share))
    }

    it('splits to the cent by largest remainder, so the shares add up to the amount', () => {
        expect(evenSplit(10000, 3)).toEqual({ share: 3333.33, extra: 1 })
        expect(shares(10000, 3)).toEqual([3333.34, 3333.33, 3333.33])
        expect(evenSplit(9000, 3)).toEqual({ share: 3000, extra: 0 })
        expect(evenSplit(0.05, 3)).toEqual({ share: 0.01, extra: 2 })
        expect(evenSplit(0.02, 3)).toEqual({ share: 0, extra: 2 })
        for (const [amount, count] of [[10000, 3], [1234.57, 7], [0.99, 4], [100000.01, 11]]) {
            const cents = shares(amount, count).reduce((sum, share) => sum + Math.round(share * 100), 0)
            expect(cents).toBe(Math.round(amount * 100))
        }
    })

    it('splits nothing over no Assets, or a price that is not positive', () => {
        expect(evenSplit(9000, 0)).toEqual({ share: 0, extra: 0 })
        expect(evenSplit(0, 3)).toEqual({ share: 0, extra: 0 })
        expect(evenSplit(-30, 3)).toEqual({ share: 0, extra: 0 })
    })
})

describe('buyoutSplit and buyoutCost', () => {
    const ids = ['c3', 'a1', 'b2']

    it("gives the left-over cents to the first Assets in sys_id order, whatever order they are listed in", () => {
        const split = buyoutSplit(10000, ids)
        expect(split).toEqual({ share: 3333.33, extraThrough: 'a1' })
        expect(ids.map((id) => buyoutCost(split, id))).toEqual([3333.33, 3333.34, 3333.33])
        const twoLeft = buyoutSplit(10000.02, [...ids, 'd4', 'd4'])
        expect(twoLeft).toEqual({ share: 2500, extraThrough: 'b2' })
        expect(['a1', 'b2', 'c3', 'd4'].map((id) => buyoutCost(twoLeft, id))).toEqual([2500.01, 2500.01, 2500, 2500])
    })

    it('adds up to the price over the Assets covered at buyout', () => {
        const covered = Array.from({ length: 7 }, (_, i) => `asset${i}`)
        const split = buyoutSplit(1234.57, covered)
        const cents = covered.reduce((sum, id) => sum + Math.round(buyoutCost(split, id) * 100), 0)
        expect(cents).toBe(123457)
    })

    it('gives every Asset the share when it divides evenly, and nothing without Assets', () => {
        const split = buyoutSplit(9000, ids)
        expect(split).toEqual({ share: 3000, extraThrough: '' })
        expect(ids.map((id) => buyoutCost(split, id))).toEqual([3000, 3000, 3000])
        expect(buyoutSplit(9000, [])).toEqual({ share: 0, extraThrough: '' })
    })

    it('costs a share stored unrounded before the upgrade to the cent', () => {
        expect(buyoutCost({ share: 10000 / 3, extraThrough: '' }, 'a1')).toBe(3333.33)
        expect(buyoutCost({ share: 20000 / 3, extraThrough: '' }, 'a1')).toBe(6666.67)
    })
})
