import { describe, expect, it } from 'vitest'
import {
    disposalApprovers,
    disposalCustomerFindings,
    disposalLineBlockers,
    disposalScopeRefusal,
    disposalStage,
    type DisposalLine,
} from './disposal'

describe('disposalStage', () => {
    it('maps each disposal method to the retired stage', () => {
        expect(disposalStage('broker_resale')).toBe('sold')
        expect(disposalStage('oem_takeback')).toBe('returned_to_oem')
        expect(disposalStage('itad_recycle')).toBe('disposed')
        expect(disposalStage('return_to_customer')).toBe('returned_to_customer')
        expect(disposalStage('return_to_lessor')).toBe('returned_to_lessor')
    })
})

describe('disposalLineBlockers', () => {
    const ready: DisposalLine = {
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

    it("returns a customer-owned asset only on its own customer's order", () => {
        const returned: DisposalLine = { ...ready, legalOwner: 'customer', method: 'return_to_customer' }
        const refused = ["asset does not belong to the order's customer"]
        expect(disposalLineBlockers({ ...returned, customerId: 'acme', orderCustomerId: 'globex' })).toEqual(refused)
        expect(disposalLineBlockers({ ...returned, customerId: '', orderCustomerId: '' })).toEqual(refused)
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
