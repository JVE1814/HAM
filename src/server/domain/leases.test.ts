import { describe, expect, it } from 'vitest'
import { buyoutPurchase, groupExpiringCoverage, leaseDecisionProblem, leaseMismatch, renewedEnd, withinLead } from './leases'

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
    it('requires a decision', () => {
        expect(leaseDecisionProblem({ decision: '', leaseEnd: '2027-06-30', newEndDate: '' })).toMatch(/Choose/)
        expect(leaseDecisionProblem({ decision: 'undecided', leaseEnd: '2027-06-30', newEndDate: '' })).toMatch(/Choose/)
    })

    it('requires an extension to move the end date out', () => {
        expect(leaseDecisionProblem({ decision: 'extend', leaseEnd: '2027-06-30', newEndDate: '2027-06-30' })).toMatch(/new end date/)
        expect(leaseDecisionProblem({ decision: 'extend', leaseEnd: '2027-06-30', newEndDate: '2028-06-30' })).toBeNull()
    })

    it('accepts buyout and return as they are', () => {
        expect(leaseDecisionProblem({ decision: 'buyout', leaseEnd: '2027-06-30', newEndDate: '' })).toBeNull()
        expect(leaseDecisionProblem({ decision: 'return', leaseEnd: '2027-06-30', newEndDate: '' })).toBeNull()
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
