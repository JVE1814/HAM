import { describe, expect, it } from 'vitest'
import { stagesQuery, type Stage } from './lifecycle'
import {
    evaluationTarget,
    feeAmount,
    overdueStep,
    returnDueDate,
    returnRequestFindings,
    shortfallRoute,
    sitePackageHoldersQuery,
    type RequestedReturn,
    type ReturnRequester,
} from './returns'

describe('returnRequestFindings', () => {
    const acmeSite: RequestedReturn = { customerId: 'acme', site: { id: 'acme-hq', customerId: 'acme', isSite: true } }
    const acmeAdmin: ReturnRequester = { mayRequest: true, scope: 'own_customer', customerId: 'acme' }
    const staff: ReturnRequester = { mayRequest: true, scope: 'everything', customerId: 'provider' }
    const serviceDesk: ReturnRequester = { mayRequest: true, scope: 'unscoped', customerId: '' }

    it("lets a customer admin request a return from one of their own customer's sites", () => {
        expect(returnRequestFindings(acmeSite, acmeAdmin)).toEqual([])
    })

    it('lets provider staff and the service desk request a return for any customer', () => {
        const globexSite: RequestedReturn = { customerId: 'globex', site: { id: 'globex-hq', customerId: 'globex', isSite: true } }
        expect(returnRequestFindings(globexSite, staff)).toEqual([])
        expect(returnRequestFindings(globexSite, serviceDesk)).toEqual([])
    })

    it("refuses a customer admin a return for another customer, even from that customer's own site", () => {
        const globexSite: RequestedReturn = { customerId: 'globex', site: { id: 'globex-hq', customerId: 'globex', isSite: true } }
        expect(returnRequestFindings(globexSite, acmeAdmin)).toEqual(['You can only request returns for your own customer'])
        expect(returnRequestFindings({ customerId: '' }, acmeAdmin)).toEqual(['You can only request returns for your own customer'])
    })

    it("refuses a site that is not one of the customer's sites, whoever asks", () => {
        const globexSite = { id: 'globex-hq', customerId: 'globex', isSite: true }
        expect(returnRequestFindings({ customerId: 'acme', site: globexSite }, acmeAdmin)).toEqual(["The site is not one of the customer's sites"])
        expect(returnRequestFindings({ customerId: 'acme', site: globexSite }, staff)).toEqual(["The site is not one of the customer's sites"])
        expect(returnRequestFindings({ customerId: 'acme', site: { id: 'acme-office', customerId: 'acme', isSite: false } }, staff)).toEqual([
            "The site is not one of the customer's sites",
        ])
        expect(returnRequestFindings({ customerId: 'acme', site: { id: 'unread', customerId: null, isSite: true } }, staff)).toEqual([
            "The site is not one of the customer's sites",
        ])
    })

    it('asks for the customer and the site when they are missing', () => {
        expect(returnRequestFindings({ customerId: '' }, staff)).toEqual(['Choose the customer'])
        expect(returnRequestFindings({ customerId: 'acme' }, staff)).toEqual(["Choose one of the customer's sites"])
    })

    it('refuses site contacts and anyone the Return create rule leaves out', () => {
        expect(returnRequestFindings(acmeSite, { mayRequest: true, scope: 'own_sites', customerId: 'acme' })).toEqual(['You may not request returns'])
        expect(returnRequestFindings(acmeSite, { mayRequest: false, scope: 'unscoped', customerId: '' })).toEqual(['You may not request returns'])
        expect(returnRequestFindings(acmeSite, { ...acmeAdmin, mayRequest: false })).toEqual(['You may not request returns'])
    })
})

describe('returnDueDate', () => {
    it('is the agreement allowance after the return was raised', () => {
        expect(returnDueDate('2026-11-07', 30)).toBe('2026-12-07')
    })
})

describe('overdueStep', () => {
    const due = '2026-12-07'
    it('does nothing before the due date or once received', () => {
        expect(overdueStep({ dueDate: due, today: '2026-12-07', graceDays: 14, received: false, escalated: false })).toBe('none')
        expect(overdueStep({ dueDate: due, today: '2027-02-01', graceDays: 14, received: true, escalated: false })).toBe('none')
    })

    it('escalates once when the due date has passed', () => {
        expect(overdueStep({ dueDate: due, today: '2026-12-08', graceDays: 14, received: false, escalated: false })).toBe('escalate')
        expect(overdueStep({ dueDate: due, today: '2026-12-08', graceDays: 14, received: false, escalated: true })).toBe('none')
    })

    it('declares the asset missing after the grace period', () => {
        expect(overdueStep({ dueDate: due, today: '2026-12-22', graceDays: 14, received: false, escalated: true })).toBe('declare_missing')
    })
})

describe('sitePackageHoldersQuery', () => {
    const query = sitePackageHoldersQuery({ siteId: 'acme-hq', agreementId: 'acme-msa' })

    it('counts only Assets at the Site under the Agreement', () => {
        for (const clause of query.split('^NQ')) {
            expect(clause).toContain('x_daas_ham_site=acme-hq^x_daas_ham_agreement=acme-msa')
        }
    })

    // A swap's new units before monitoring sees them, units serving there and units still to come back.
    it.each<Stage>(['shipped', 'pending_in_service', 'in_service', 'temporary_deployment', 'pending_return'])(
        'is held open by a unit %s',
        (stage) => expect(query).toContain(stagesQuery([stage])),
    )

    it.each<Stage>(['pending_evaluation', 'missing', 'available'])('lets go of a unit %s', (stage) => {
        expect(query).not.toContain(stagesQuery([stage]))
    })
})

describe('evaluationTarget', () => {
    it('returns provider-owned units in good order to stock', () => {
        expect(evaluationTarget('refurbish', 'provider')).toBe('available')
        expect(evaluationTarget('refurbish', 'lessor')).toBe('available')
    })

    it('never refurbishes customer-owned units into provider stock', () => {
        expect(evaluationTarget('refurbish', 'customer')).toBe('pending_wipe')
    })

    it('sends defective units to the OEM and scrap or hand-backs to wiping', () => {
        expect(evaluationTarget('oem_rma', 'provider')).toBe('pending_oem_rma')
        expect(evaluationTarget('scrap', 'provider')).toBe('pending_wipe')
        expect(evaluationTarget('return_to_owner', 'lessor')).toBe('pending_wipe')
    })
})

describe('feeAmount', () => {
    it('takes the agreement fee for the event type', () => {
        const fees = { lost: 1500, damaged: 400, late_return: 150 }
        expect(feeAmount('lost', fees)).toBe(1500)
        expect(feeAmount('late_return', fees)).toBe(150)
    })
})

describe('shortfallRoute', () => {
    it('asks the OEM for an advance replacement when a covered unit fails and no stock is left', () => {
        expect(shortfallRoute({ missing: 1, purpose: 'replace', coveredToday: true })).toBe('oem_advance_replacement')
    })

    it('purchases otherwise', () => {
        expect(shortfallRoute({ missing: 1, purpose: 'replace', coveredToday: false })).toBe('purchase')
        expect(shortfallRoute({ missing: 2, purpose: 'new', coveredToday: true })).toBe('purchase')
        expect(shortfallRoute({ missing: 0, purpose: 'replace', coveredToday: true })).toBe('none')
    })
})
