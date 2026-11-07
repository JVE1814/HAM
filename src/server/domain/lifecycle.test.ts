import { describe, expect, it } from 'vitest'
import { checkTransition, fieldsOf, isBillable, isDeployed, stageOf, stagesQuery, type Stage, type TransitionFacts } from './lifecycle'

const deployable: TransitionFacts = {
    hasSite: true,
    hasAgreement: true,
    legalOwner: 'provider',
    wipeEvidenceComplete: false,
}

describe('stage mapping', () => {
    it('maps platform install status and substatus to a lifecycle stage and back', () => {
        expect(stageOf({ installStatus: '6', substatus: 'staging' })).toBe('staging')
        expect(stageOf({ installStatus: '1', substatus: '' })).toBe('in_service')
        expect(fieldsOf('pending_in_service')).toEqual({ installStatus: '1', substatus: 'pending_in_service' })
    })

    it('reports platform combinations the app does not model as unknown', () => {
        expect(stageOf({ installStatus: '6', substatus: 'defective' })).toBeNull()
    })

    it('treats a missing substatus the same as an empty one', () => {
        expect(stageOf({ installStatus: '2', substatus: null })).toBe('on_order')
    })
})

describe('checkTransition', () => {
    it('allows the happy path from receipt to in service', () => {
        const path = [
            'in_transit',
            'available',
            'reserved',
            'staging',
            'staged',
            'shipped',
            'pending_in_service',
            'in_service',
        ] as const
        for (let i = 1; i < path.length; i++) {
            expect(checkTransition(path[i - 1], path[i], deployable)).toEqual({ allowed: true })
        }
    })

    it('rejects moves that skip lifecycle stages', () => {
        const verdict = checkTransition('available', 'in_service', deployable)
        expect(verdict).toEqual({ allowed: false, reason: 'Cannot move an asset from available to in_service' })
    })

    it('requires a site and an agreement before an asset leaves for a site', () => {
        const verdict = checkTransition('staged', 'shipped', { ...deployable, hasSite: false })
        expect(verdict.allowed).toBe(false)
        expect(verdict.allowed === false && verdict.reason).toMatch(/site/)

        const noAgreement = checkTransition('staged', 'shipped', { ...deployable, hasAgreement: false })
        expect(noAgreement.allowed === false && noAgreement.reason).toMatch(/agreement/)
    })

    it('lets a hot spare at a customer site go straight to install', () => {
        expect(checkTransition('spare_pool', 'pending_in_service', deployable)).toEqual({ allowed: true })
    })

    it('only lets leased assets leave by returning them to the lessor', () => {
        const leased: TransitionFacts = { ...deployable, legalOwner: 'lessor', wipeEvidenceComplete: true }
        expect(checkTransition('pending_disposal', 'sold', leased).allowed).toBe(false)
        expect(checkTransition('pending_disposal', 'returned_to_lessor', leased)).toEqual({ allowed: true })
    })

    it('only returns customer-owned assets to the customer', () => {
        const customerOwned: TransitionFacts = { ...deployable, legalOwner: 'customer', wipeEvidenceComplete: true }
        expect(checkTransition('pending_disposal', 'disposed', customerOwned).allowed).toBe(false)
        expect(checkTransition('pending_disposal', 'returned_to_customer', customerOwned)).toEqual({ allowed: true })
        expect(
            checkTransition('pending_disposal', 'returned_to_customer', { ...customerOwned, legalOwner: 'provider' })
                .allowed,
        ).toBe(false)
    })

    it('requires wipe evidence before any asset is retired', () => {
        const verdict = checkTransition('pending_disposal', 'sold', deployable)
        expect(verdict.allowed === false && verdict.reason).toMatch(/wipe evidence/)
        expect(checkTransition('pending_disposal', 'sold', { ...deployable, wipeEvidenceComplete: true })).toEqual({
            allowed: true,
        })
    })

    it('never moves an asset out of a retired stage', () => {
        expect(checkTransition('disposed', 'available', deployable).allowed).toBe(false)
    })

    it('refuses to move an asset whose current stage is unknown', () => {
        const verdict = checkTransition(null, 'available', deployable)
        expect(verdict.allowed === false && verdict.reason).toMatch(/administrator/)
    })

    it('accepts a no-op move to the same stage', () => {
        expect(checkTransition('in_service', 'in_service', deployable)).toEqual({ allowed: true })
    })
})

describe('isDeployed', () => {
    it('counts assets that are at or on their way to a site', () => {
        expect(isDeployed('shipped')).toBe(true)
        expect(isDeployed('in_service')).toBe(true)
        expect(isDeployed('pending_return')).toBe(true)
        expect(isDeployed('spare_pool')).toBe(false)
        expect(isDeployed(null)).toBe(false)
    })
})

describe('stagesQuery', () => {
    it('builds one OR-ed clause per stage, each carrying the base query', () => {
        expect(stagesQuery(['in_service', 'shipped'], 'x_daas_ham_agreement=a1')).toBe(
            'install_status=1^substatusISEMPTY^x_daas_ham_agreement=a1^NQinstall_status=9^substatus=shipped_to_site^x_daas_ham_agreement=a1',
        )
    })

    it('works without a base query', () => {
        expect(stagesQuery(['available'])).toBe('install_status=6^substatus=available')
    })

    it('dot-walks to the asset from a related table', () => {
        expect(stagesQuery(['in_service', 'available'], 'covered=true', 'asset.')).toBe(
            'asset.install_status=1^asset.substatusISEMPTY^covered=true^NQasset.install_status=6^asset.substatus=available^covered=true',
        )
    })

    it('marks in-service and temporary assets as billable', () => {
        expect(['in_service', 'temporary_deployment', 'pending_return', 'shipped'].map((s) => isBillable(s as Stage))).toEqual([true, true, false, false])
        expect(isBillable(null)).toBe(false)
    })
})
