import { describe, expect, it } from 'vitest'
import { billingChange, checkTransition, DEPLOYED_STAGES, fieldsOf, isBillable, isDeployed, SERVING_STAGES, stageOf, stagesQuery, type Stage, type TransitionFacts } from './lifecycle'

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

    it('sends a leased asset to the OEM only under an OEM RMA', () => {
        const leased: TransitionFacts = { ...deployable, legalOwner: 'lessor', wipeEvidenceComplete: true }
        expect(checkTransition('pending_disposal', 'returned_to_oem', leased)).toEqual({
            allowed: false,
            reason: 'A lessor-owned asset goes to the OEM only under an OEM RMA',
        })
        expect(checkTransition('pending_oem_rma', 'returned_to_oem', leased)).toEqual({ allowed: true })
        const owned: TransitionFacts = { ...leased, legalOwner: 'provider' }
        expect(checkTransition('pending_disposal', 'returned_to_oem', owned)).toEqual({ allowed: true })
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
})

describe('serving and deployed stages', () => {
    it('serves customers at or on the way to a site, and counts assets coming back as deployed too', () => {
        expect(SERVING_STAGES).toEqual(['shipped', 'pending_in_service', 'in_service', 'temporary_deployment'])
        expect(DEPLOYED_STAGES).toEqual([...SERVING_STAGES, 'pending_return'])
    })
})

describe('isBillable', () => {
    it('marks in-service and temporary assets as billable', () => {
        expect(['in_service', 'temporary_deployment', 'pending_return', 'shipped'].map((s) => isBillable(s as Stage))).toEqual([true, true, false, false])
        expect(isBillable(null)).toBe(false)
    })
})

describe('billingChange', () => {
    const dates = { inServiceDate: '2026-11-02', today: '2026-11-07' }

    it('starts billing from the in-service date on first go-live', () => {
        expect(billingChange('pending_in_service', 'in_service', dates)).toEqual({ start: '2026-11-02' })
        expect(billingChange('pending_in_service', 'temporary_deployment', dates)).toEqual({ start: '2026-11-02' })
    })

    it('starts billing today when an asset comes back into service, or has no in-service date', () => {
        expect(billingChange('missing', 'in_service', dates)).toEqual({ start: '2026-11-07' })
        expect(billingChange('pending_in_service', 'in_service', { today: '2026-11-07' })).toEqual({ start: '2026-11-07' })
    })

    it('stops billing today on leaving service, whatever the route', () => {
        expect(billingChange('in_service', 'pending_return', dates)).toEqual({ stop: '2026-11-07' })
        expect(billingChange('temporary_deployment', 'missing', dates)).toEqual({ stop: '2026-11-07' })
        expect(billingChange('in_service', null, dates)).toEqual({ stop: '2026-11-07' })
    })

    it('leaves billing alone when the asset stays in or out of service', () => {
        expect(billingChange('in_service', 'temporary_deployment', dates)).toBeNull()
        expect(billingChange('pending_return', 'pending_evaluation', dates)).toBeNull()
        expect(billingChange(null, 'available', dates)).toBeNull()
    })
})
