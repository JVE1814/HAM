import { describe, expect, it } from 'vitest'
import { disposalApprovers, disposalLineBlockers, disposalStage } from './disposal'

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
    const ready = { legalOwner: 'provider' as const, method: 'itad_recycle' as const, wipeComplete: true, stage: 'pending_disposal' as const }

    it('passes a wiped provider-owned asset awaiting disposal', () => {
        expect(disposalLineBlockers(ready)).toEqual([])
    })

    it('requires wipe evidence, the right stage and a method allowed for the legal owner', () => {
        expect(disposalLineBlockers({ ...ready, wipeComplete: false })).toEqual(['no wipe evidence'])
        expect(disposalLineBlockers({ ...ready, stage: 'in_service' })).toEqual(['asset is in_service, not awaiting wipe or disposal'])
        expect(disposalLineBlockers({ ...ready, legalOwner: 'lessor' })).toEqual(['a lessor-owned asset can only be return to lessor'])
        expect(disposalLineBlockers({ ...ready, legalOwner: 'customer', method: 'return_to_customer' })).toEqual([])
    })
})

describe('disposalApprovers', () => {
    it('needs the provider, and the customer when any asset is customer-owned', () => {
        expect(disposalApprovers(['provider', 'lessor'])).toEqual(['account_manager'])
        expect(disposalApprovers(['provider', 'customer'])).toEqual(['account_manager', 'customer_admin'])
    })
})
