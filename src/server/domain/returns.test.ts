import { describe, expect, it } from 'vitest'
import { ALL_STAGES, checkTransition, DEPLOYED_STAGES, INSTALLED_STAGES, type Stage } from './lifecycle'
import {
    chargedFeeQuery,
    collectionMethod,
    evaluationTarget,
    isSiteRecovery,
    opensDeinstallWork,
    overdueStep,
    receivedLate,
    requestedTrigger,
    returnDueDate,
    returnRequestFindings,
    returnRequesterRefusal,
    SITE_RECOVERY_STAGES,
    sitePackageHoldersQuery,
    deploymentEndLineQuery,
    stagesTakenBack,
    type RequestedReturn,
    type ReturnRequester,
} from './returns'
import { type LeaseEndAction, RETURN_TRIGGER_CHOICES, type ReturnTrigger } from './vocabulary'
import { recordMatches as matches } from '../test-support/encoded-query'
import { assetIn, type SampleRecord } from '../test-support/stored-asset'

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
        expect(returnRequestFindings(globexSite, acmeAdmin)).toEqual([{ about: 'requester', message: 'You can only request returns for your own customer' }])
        expect(returnRequestFindings({ customerId: '' }, acmeAdmin)).toEqual([{ about: 'requester', message: 'You can only request returns for your own customer' }])
    })

    it("refuses a site that is not one of the customer's sites, whoever asks", () => {
        const globexSite = { id: 'globex-hq', customerId: 'globex', isSite: true }
        expect(returnRequestFindings({ customerId: 'acme', site: globexSite }, acmeAdmin)).toEqual([{ about: 'site', message: "The site is not one of the customer's sites" }])
        expect(returnRequestFindings({ customerId: 'acme', site: globexSite }, staff)).toEqual([{ about: 'site', message: "The site is not one of the customer's sites" }])
        expect(returnRequestFindings({ customerId: 'acme', site: { id: 'acme-office', customerId: 'acme', isSite: false } }, staff)).toEqual([
            { about: 'site', message: "The site is not one of the customer's sites" },
        ])
        expect(returnRequestFindings({ customerId: 'acme', site: { id: 'unread', customerId: null, isSite: true } }, staff)).toEqual([
            { about: 'site', message: "The site is not one of the customer's sites" },
        ])
    })

    it('asks for the customer and the site when they are missing', () => {
        expect(returnRequestFindings({ customerId: '' }, staff)).toEqual([{ about: 'site', message: 'Choose the customer' }])
        expect(returnRequestFindings({ customerId: 'acme' }, staff)).toEqual([{ about: 'site', message: "Choose one of the customer's sites" }])
    })

    it('refuses site contacts and anyone the Return create rule leaves out', () => {
        expect(returnRequestFindings(acmeSite, { mayRequest: true, scope: 'own_sites', customerId: 'acme' })).toEqual([{ about: 'requester', message: 'You may not request returns' }])
        expect(returnRequestFindings(acmeSite, { mayRequest: false, scope: 'unscoped', customerId: '' })).toEqual([{ about: 'requester', message: 'You may not request returns' }])
        expect(returnRequestFindings(acmeSite, { ...acmeAdmin, mayRequest: false })).toEqual([{ about: 'requester', message: 'You may not request returns' }])
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

    it("allows 30 days when the Agreement names no allowance", () => {
        expect(returnDueDate('2026-11-07', 0)).toBe('2026-12-07')
    })
})

describe('opensDeinstallWork', () => {
    it('opens de-install work for a field de-install', () => {
        expect(opensDeinstallWork('site_decommission', 'fsm_deinstall')).toBe(true)
        expect(opensDeinstallWork('device_removal', 'fsm_deinstall')).toBe(true)
        expect(opensDeinstallWork('agreement_end', 'fsm_deinstall')).toBe(true)
        expect(opensDeinstallWork('temporary_end', 'fsm_deinstall')).toBe(true)
    })

    it('opens none when the Site contact ships the units back', () => {
        expect(opensDeinstallWork('device_removal', 'ship_back')).toBe(false)
        expect(opensDeinstallWork('temporary_end', 'ship_back')).toBe(false)
    })

    it("opens none for a swapped-out unit, which the swap's own work order collects", () => {
        expect(opensDeinstallWork('refresh_swap_back', 'fsm_deinstall')).toBe(false)
        expect(opensDeinstallWork('defective_return', 'fsm_deinstall')).toBe(false)
    })
})

describe('collectionMethod', () => {
    it('has the Site ship back what it installed itself, and a field engineer collect the rest', () => {
        expect(collectionMethod('self_install')).toBe('ship_back')
        expect(collectionMethod('fsm_engineer')).toBe('fsm_deinstall')
        expect(collectionMethod('')).toBe('fsm_deinstall')
    })
})

describe('receivedLate', () => {
    it('is late only after the due date', () => {
        expect(receivedLate('2026-11-07', '2026-11-07')).toBe(false)
        expect(receivedLate('2026-11-07', '2026-11-08')).toBe(true)
    })

    it('is never late on a Return order without a due date', () => {
        expect(receivedLate('', '2026-11-08')).toBe(false)
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
    /** A fleet asset at the Site under the Agreement, in `stage`. */
    const unit = (stage: Stage, fields: SampleRecord = {}) => assetIn(stage, { x_daas_ham_fleet: 'true', x_daas_ham_site: 'acme-hq', x_daas_ham_agreement: 'acme-msa', ...fields })
    const holding = (fields: SampleRecord = {}) => ALL_STAGES.filter((stage) => matches(query, unit(stage, fields)))

    // A swap's new units before monitoring sees them, units serving there and units still to come back.
    it('is held open by a unit shipped, awaiting first sighting, in service, temporarily deployed or awaiting return, and by no other', () => {
        expect(holding()).toEqual(['shipped', 'pending_in_service', 'in_service', 'temporary_deployment', 'pending_return'])
    })

    it.each<Stage>(['pending_evaluation', 'missing', 'available'])('lets go of a unit %s', (stage) => {
        expect(matches(query, unit(stage))).toBe(false)
    })

    it('counts only Assets at the Site under the Agreement, whatever their stage', () => {
        expect(holding({ x_daas_ham_site: 'acme-branch' })).toEqual([])
        expect(holding({ x_daas_ham_agreement: 'acme-old' })).toEqual([])
        expect(holding({ x_daas_ham_site: '' })).toEqual([])
    })

    it('counts fleet assets only, whatever their stage (ADR 0016)', () => {
        expect(holding({ x_daas_ham_fleet: 'false' })).toEqual([])
        expect(holding({ x_daas_ham_fleet: '' })).toEqual([])
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

describe('deploymentEndLineQuery', () => {
    const query = deploymentEndLineQuery('a1')
    const line = (fields: SampleRecord = {}) => ({ asset: 'a1', status: 'awaiting', 'return_order.trigger': 'site_decommission', ...fields })
    const triggers = Object.keys(RETURN_TRIGGER_CHOICES) as ReturnTrigger[]

    it('finds the line that awaits the Asset back on a site decommission, agreement end or temporary end, and on no other Return', () => {
        expect(triggers.filter((trigger) => matches(query, line({ 'return_order.trigger': trigger })))).toEqual(['site_decommission', 'agreement_end', 'temporary_end'])
    })

    it("finds no other Asset's line, nor one whose unit is back, evaluated or declared missing", () => {
        expect(matches(query, line({ asset: 'a2' }))).toBe(false)
        for (const status of ['received', 'evaluated', 'missing']) expect(matches(query, line({ status })), status).toBe(false)
    })
})

describe('a whole-Site recovery, by the trigger of its Return', () => {
    const triggers = Object.keys(RETURN_TRIGGER_CHOICES) as ReturnTrigger[]

    it('is a site decommission or an agreement end, and no other Return', () => {
        expect(triggers.filter(isSiteRecovery)).toEqual(['site_decommission', 'agreement_end'])
    })

    it('takes the units still shipped to the Site too, as a temporary end does; any other Return the installed ones', () => {
        for (const trigger of triggers) {
            const takesShipped = isSiteRecovery(trigger) || trigger === 'temporary_end'
            expect(stagesTakenBack(trigger)).toBe(takesShipped ? SITE_RECOVERY_STAGES : INSTALLED_STAGES)
        }
    })

    it('is what a Customer requests for a whole Site: a decommission, else a device removal', () => {
        expect(requestedTrigger(true)).toBe('site_decommission')
        expect(requestedTrigger(false)).toBe('device_removal')
        expect(isSiteRecovery(requestedTrigger(true))).toBe(true)
        expect(isSiteRecovery(requestedTrigger(false))).toBe(false)
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

describe('fee identity', () => {
    const sysId = (c: string) => c.repeat(32)
    const fee = { type: 'late_return' as const, assetId: sysId('a'), returnOrderId: sysId('r') }

    const charge = (fields: SampleRecord = {}) => ({ fee_type: 'late_return', asset: sysId('a'), return_order: sysId('r'), status: 'open', ...fields })

    it('counts every charge of the same type, Asset and Return order but a waived one', () => {
        expect(matches(chargedFeeQuery(fee), charge())).toBe(true)
        expect(matches(chargedFeeQuery(fee), charge({ status: 'billed' }))).toBe(true)
        expect(matches(chargedFeeQuery(fee), charge({ status: 'waived' }))).toBe(false)
    })

    it('counts no charge of another type, Asset or Return order', () => {
        expect(matches(chargedFeeQuery(fee), charge({ fee_type: 'lost' }))).toBe(false)
        expect(matches(chargedFeeQuery(fee), charge({ asset: sysId('b') }))).toBe(false)
        expect(matches(chargedFeeQuery(fee), charge({ return_order: sysId('s') }))).toBe(false)
    })
})
