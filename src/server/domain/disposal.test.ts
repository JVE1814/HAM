import { describe, expect, it } from 'vitest'
import {
    disposalApprovers,
    disposalCustomerFindings,
    disposalLineBlockers,
    disposalScopeRefusal,
    type DisposalLine,
} from './disposal'
import { checkTransition, disposalStage } from './lifecycle'
import { DISPOSAL_METHOD_CHOICES, LEGAL_OWNER_CHOICES, type DisposalMethod, type LegalOwner } from './vocabulary'

describe('disposalLineBlockers', () => {
    const ready: DisposalLine = {
        fleet: true,
        legalOwner: 'provider',
        method: 'itad_recycle',
        wipeComplete: true,
        stage: 'pending_disposal',
        customerId: 'provider-co',
        orderCustomerId: '',
    }

    it('passes a wiped provider-owned asset awaiting disposal', () => {
        expect(disposalLineBlockers(ready)).toEqual([])
    })

    it('requires wipe evidence, the right stage and a method allowed for the legal owner', () => {
        expect(disposalLineBlockers({ ...ready, wipeComplete: false })).toEqual(['no wipe evidence'])
        expect(disposalLineBlockers({ ...ready, stage: 'in_service' })).toEqual(['asset is in_service, not awaiting wipe or disposal'])
        expect(disposalLineBlockers({ ...ready, legalOwner: 'lessor' })).toEqual(['a lessor-owned asset can only be return to lessor'])
        const returned: DisposalLine = { ...ready, legalOwner: 'customer', method: 'return_to_customer' }
        expect(disposalLineBlockers({ ...returned, customerId: 'acme', orderCustomerId: 'acme' })).toEqual([])
    })

    it("retires no asset outside the fleet, the Provider IT's (ADR 0016)", () => {
        expect(disposalLineBlockers({ ...ready, fleet: false })).toEqual(['asset is not a fleet asset'])
    })

    it("returns a customer-owned asset only on its own customer's order", () => {
        const returned: DisposalLine = { ...ready, legalOwner: 'customer', method: 'return_to_customer' }
        const refused = ["asset does not belong to the order's customer"]
        expect(disposalLineBlockers({ ...returned, customerId: 'acme', orderCustomerId: 'globex' })).toEqual(refused)
        expect(disposalLineBlockers({ ...returned, customerId: '', orderCustomerId: '' })).toEqual(refused)
    })
})

describe('how an Asset may leave, by its legal owner', () => {
    const OPEN_TO: Record<LegalOwner, readonly DisposalMethod[]> = {
        provider: ['broker_resale', 'oem_takeback', 'itad_recycle'],
        customer: ['return_to_customer'],
        lessor: ['return_to_lessor'],
    }
    const owners = Object.keys(LEGAL_OWNER_CHOICES) as LegalOwner[]
    const methods = Object.keys(DISPOSAL_METHOD_CHOICES) as DisposalMethod[]
    const pairs = owners.flatMap((owner) => methods.map((method) => ({ owner, method, open: OPEN_TO[owner].includes(method) })))
    const line = (legalOwner: LegalOwner | '', method: DisposalMethod): DisposalLine => ({
        fleet: true,
        legalOwner,
        method,
        wipeComplete: true,
        stage: 'pending_disposal',
        customerId: 'acme',
        orderCustomerId: 'acme',
    })
    const retire = (legalOwner: LegalOwner | '', method: DisposalMethod) =>
        checkTransition('pending_disposal', disposalStage(method), { hasSite: false, hasAgreement: false, legalOwner, wipeEvidenceComplete: true })

    it.each(pairs.filter((pair) => pair.open))('lets a $owner-owned asset leave by $method: the line completes and the move is allowed', ({ owner, method }) => {
        expect(disposalLineBlockers(line(owner, method))).toEqual([])
        expect(retire(owner, method)).toEqual({ allowed: true })
    })

    it.each(pairs.filter((pair) => !pair.open))('refuses a $owner-owned asset leaving by $method: the line is blocked and the move refused', ({ owner, method }) => {
        const allowed = OPEN_TO[owner].map((m) => m.replace(/_/g, ' ')).join(' or ')
        expect(disposalLineBlockers(line(owner, method))).toEqual([`a ${owner}-owned asset can only be ${allowed}`])
        expect(retire(owner, method).allowed).toBe(false)
    })

    it("treats an asset with no legal owner as the Provider's", () => {
        for (const method of methods) {
            expect(disposalLineBlockers(line('', method))).toEqual(disposalLineBlockers(line('provider', method)))
            expect(retire('', method)).toEqual(retire('provider', method))
        }
    })
})

describe('disposalCustomerFindings', () => {
    const acme = { legalOwner: 'customer' as const, customerId: 'acme', label: 'SN-1' }

    it('needs no customer when no asset is customer-owned', () => {
        const owned = { legalOwner: 'provider' as const, customerId: 'provider-co', label: 'SN-0' }
        expect(disposalCustomerFindings('', [owned])).toEqual([])
    })

    it("asks for the customer, and refuses another customer's assets", () => {
        expect(disposalCustomerFindings('', [acme])).toEqual(['Set the customer whose assets are being returned'])
        expect(disposalCustomerFindings('acme', [acme])).toEqual([])
        expect(disposalCustomerFindings('acme', [acme, { ...acme, customerId: 'globex', label: 'SN-2' }])).toEqual([
            "Not the order's customer's assets: SN-2",
        ])
    })
})

describe('disposalScopeRefusal', () => {
    it('lets a draft order change, and an order being deleted drop its lines', () => {
        expect(disposalScopeRefusal(['draft'])).toBe('')
        expect(disposalScopeRefusal(['draft', 'draft'])).toBe('')
        expect(disposalScopeRefusal([''])).toBe('')
    })

    it('freezes what an order retires once it leaves draft, including a line moved into or out of it', () => {
        for (const stage of ['awaiting_approval', 'approved', 'completed', 'rejected']) {
            expect(disposalScopeRefusal([stage])).toMatch(/submitted/)
        }
        expect(disposalScopeRefusal(['draft', 'approved'])).toMatch(/submitted/)
    })
})

describe('disposalApprovers', () => {
    it('needs the provider, and the customer when any asset is customer-owned', () => {
        expect(disposalApprovers(['provider', 'lessor'])).toEqual(['account_manager'])
        expect(disposalApprovers(['provider', 'customer'])).toEqual(['account_manager', 'customer_admin'])
    })
})
