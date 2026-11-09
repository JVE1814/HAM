import { describe, expect, it } from 'vitest'
import { checkTransition, DEPLOYED_STAGES, stagesQuery, type Stage } from './lifecycle'
import {
    chargedFeeQuery,
    evaluationTarget,
    feeAmount,
    feeLockName,
    INSTALLED_STAGES,
    overdueStep,
    returnDueDate,
    returnRequestFindings,
    returnRequesterRefusal,
    shortfallRoute,
    SITE_RECOVERY_STAGES,
    sitePackageHoldersQuery,
    type RequestedReturn,
    type ReturnRequester,
} from './returns'
import type { LeaseEndAction } from './vocabulary'

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

describe('returnRequesterRefusal', () => {
    it('says only who may ask, so a caller can tell a refused requester from a wrong site', () => {
        const acmeAdmin: ReturnRequester = { mayRequest: true, scope: 'own_customer', customerId: 'acme' }
        const staff: ReturnRequester = { mayRequest: true, scope: 'everything', customerId: 'provider' }
        expect(returnRequesterRefusal('acme', acmeAdmin)).toBeNull()
        expect(returnRequesterRefusal('globex', staff)).toBeNull()
        expect(returnRequesterRefusal('globex', acmeAdmin)).toBe('You can only request returns for your own customer')
        expect(returnRequesterRefusal('acme', { ...acmeAdmin, mayRequest: false })).toBe('You may not request returns')
        expect(returnRequesterRefusal('acme', { ...acmeAdmin, scope: 'own_sites' })).toBe('You may not request returns')
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

    it('counts fleet assets only, in every clause (ADR 0016)', () => {
        for (const clause of query.split('^NQ')) expect(clause.split('^')).toContain('x_daas_ham_fleet=true')
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

describe('SITE_RECOVERY_STAGES', () => {
    // Facts a unit at a Site under an Agreement has; pending return needs nothing more.
    const atSite = { hasSite: true, hasAgreement: true, legalOwner: 'provider', wipeEvidenceComplete: false } as const

    it('takes every unit that holds the site package open, but those already coming back', () => {
        expect([...SITE_RECOVERY_STAGES, 'pending_return'].sort()).toEqual([...DEPLOYED_STAGES].sort())
    })

    it('takes the units still shipped to the Site, which installed-only lists leave out', () => {
        expect(SITE_RECOVERY_STAGES).toContain('shipped')
        expect(INSTALLED_STAGES).not.toContain('shipped')
        for (const stage of INSTALLED_STAGES) expect(SITE_RECOVERY_STAGES).toContain(stage)
    })

    it.each(SITE_RECOVERY_STAGES)('can move a unit %s to pending return', (stage) => {
        expect(checkTransition(stage, 'pending_return', atSite)).toEqual({ allowed: true })
    })
})

describe('evaluationTarget', () => {
    const provider = { legalOwner: 'provider', leaseEndAction: '' } as const
    const customer = { legalOwner: 'customer', leaseEndAction: '' } as const
    const lessor = (leaseEndAction: LeaseEndAction | '') => ({ legalOwner: 'lessor', leaseEndAction }) as const

    it('returns units in good order to stock', () => {
        expect(evaluationTarget('refurbish', provider)).toBe('available')
    })

    it.each<LeaseEndAction | ''>(['', 'undecided', 'extend', 'buyout'])(
        'returns a lessor-owned unit to stock while its lease is not being returned (%s)',
        (endAction) => expect(evaluationTarget('refurbish', lessor(endAction))).toBe('available'),
    )

    it('never refurbishes customer-owned units into provider stock', () => {
        expect(evaluationTarget('refurbish', customer)).toBe('pending_wipe')
    })

    it('sends the units of a lease being returned to wiping for the lessor, not to stock', () => {
        expect(evaluationTarget('refurbish', lessor('return'))).toBe('pending_wipe')
        expect(evaluationTarget('scrap', lessor('return'))).toBe('pending_wipe')
    })

    it('sends defective units to the OEM and scrap or hand-backs to wiping', () => {
        expect(evaluationTarget('oem_rma', provider)).toBe('pending_oem_rma')
        expect(evaluationTarget('oem_rma', lessor('return'))).toBe('pending_oem_rma')
        expect(evaluationTarget('scrap', provider)).toBe('pending_wipe')
        expect(evaluationTarget('return_to_owner', lessor(''))).toBe('pending_wipe')
    })
})

describe('feeAmount', () => {
    it('takes the agreement fee for the event type', () => {
        const fees = { lost: 1500, damaged: 400, late_return: 150 }
        expect(feeAmount('lost', fees)).toBe(1500)
        expect(feeAmount('late_return', fees)).toBe(150)
    })
})

describe('fee identity', () => {
    const sysId = (c: string) => c.repeat(32)
    const fee = { type: 'late_return' as const, assetId: sysId('a'), returnOrderId: sysId('r') }

    it('counts every charge of the same type, Asset and Return order but a waived one', () => {
        const charged = `fee_type=late_return^asset=${sysId('a')}^return_order=${sysId('r')}^status!=waived`
        expect(chargedFeeQuery(fee)).toBe(charged)
    })

    it('locks each fee identity on its own, within the job lock name length', () => {
        const names = [
            fee,
            { ...fee, type: 'lost' as const },
            { ...fee, assetId: sysId('b') },
            { ...fee, returnOrderId: sysId('s') },
        ].map(feeLockName)
        expect(new Set(names).size).toBe(names.length)
        for (const name of names) expect(name.length).toBeLessThanOrEqual(100)
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
