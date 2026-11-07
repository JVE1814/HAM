import { describe, expect, it } from 'vitest'
import {
    buyoutPurchase,
    evenShare,
    groupExpiringCoverage,
    leaseDecisionProblem,
    leaseMismatch,
    renewedEnd,
    stillCovered,
    stockReturnMoves,
    withinLead,
} from './leases'
import { ALL_STAGES, checkTransition, type TransitionFacts } from './lifecycle'

describe('withinLead', () => {
    it('is due from lead days before the end date onwards', () => {
        expect(withinLead('2027-03-01', '2026-11-01', 120)).toBe(true)
        expect(withinLead('2027-03-01', '2026-10-31', 120)).toBe(false)
        expect(withinLead('2026-01-01', '2026-11-07', 30)).toBe(true)
    })

    it('never fires without an end date', () => {
        expect(withinLead('', '2026-11-07', 30)).toBe(false)
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
        expect(stillCovered('x_daas_ham_lease=L1')).toBe('x_daas_ham_lease=L1^install_status!=7')
        const bought = 'x_daas_ham_lease.end_action=buyout'
        expect(stillCovered(bought)).toBe(`${bought}^install_status!=7`)
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

describe('renewedEnd', () => {
    it('adds the renewal term (at least one month)', () => {
        expect(renewedEnd('2026-12-31', 12)).toBe('2027-12-31')
        expect(renewedEnd('2026-12-31', 0)).toBe('2027-01-31')
        expect(renewedEnd('2026-11-15', 3)).toBe('2027-02-15')
    })

    it('keeps a month-end end at month end, so a day clamped in a short month is not lost', () => {
        expect(renewedEnd('2026-11-30', 3)).toBe('2027-02-28')
        expect(renewedEnd('2027-02-28', 3)).toBe('2027-05-31')
        expect(renewedEnd('2027-02-28', 12)).toBe('2028-02-29')
        expect(renewedEnd('2026-09-30', 3)).toBe('2026-12-31')
        expect(renewedEnd('2027-04-30', 1)).toBe('2027-05-31')
    })

    it('clamps an end past the last day of a shorter month, as before', () => {
        expect(renewedEnd('2027-01-30', 1)).toBe('2027-02-28')
    })
})

describe('groupExpiringCoverage', () => {
    it('counts contracts per customer and keeps the first end date', () => {
        const groups = groupExpiringCoverage([
            { customerId: 'acme', endDate: '2026-12-20' },
            { customerId: 'acme', endDate: '2026-12-01' },
            { customerId: 'globex', endDate: '2027-01-05' },
        ])
        expect(groups.get('acme')).toEqual({ count: 2, firstEnd: '2026-12-01' })
        expect(groups.get('globex')).toEqual({ count: 1, firstEnd: '2027-01-05' })
    })
})

describe('evenShare', () => {
    it('splits an amount evenly, e.g. a buyout price over the Assets covered', () => {
        expect(evenShare(9000, 3)).toBe(3000)
        expect(evenShare(0, 3)).toBe(0)
    })

    it('gives no share when there is none to split it over', () => {
        expect(evenShare(9000, 0)).toBe(0)
    })
})
