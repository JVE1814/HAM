import { describe, expect, it } from 'vitest'
import {
    ALL_STAGES,
    billingChange,
    checkTransition,
    DEPLOYED_STAGES,
    fieldsOf,
    isBillable,
    isDeployed,
    SERVING_STAGES,
    stageAfterTransfer,
    stageChangeRefusal,
    stageOf,
    stagesQuery,
    transferFellThrough,
    voidsWipeEvidence,
    type Stage,
    type TransferContext,
    type TransitionFacts,
} from './lifecycle'

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

    it("reads both of Inventory's transfer combinations as in transfer, and gives the first back", () => {
        expect(stageOf({ installStatus: '6', substatus: 'pending_transfer' })).toBe('in_transfer')
        expect(stageOf({ installStatus: '9', substatus: 'reserved' })).toBe('in_transfer')
        expect(fieldsOf('in_transfer')).toEqual({ installStatus: '6', substatus: 'pending_transfer' })
    })

    it('keeps In stock / Reserved and plain In transit their own stages', () => {
        expect(stageOf({ installStatus: '6', substatus: 'reserved' })).toBe('reserved')
        expect(stageOf({ installStatus: '9', substatus: '' })).toBe('in_transit')
    })

    it.each(ALL_STAGES)('reads the combination %s is stored as back as that stage', (stage) => {
        expect(stageOf(fieldsOf(stage))).toBe(stage)
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

    it.each(['shipped', 'pending_in_service', 'in_service', 'temporary_deployment', 'pending_return'] as const)(
        'lets a unit at or towards its Site (%s) be declared missing, as an overdue return does',
        (from) => {
            expect(checkTransition(from, 'missing', deployable)).toEqual({ allowed: true })
            expect(checkTransition(from, 'missing', { ...deployable, hasSite: false, hasAgreement: false })).toEqual({ allowed: true })
        },
    )

    it('lets every deployed stage go missing, so no overdue return is refused for the stage its unit is in', () => {
        for (const from of DEPLOYED_STAGES) expect(checkTransition(from, 'missing', deployable), from).toEqual({ allowed: true })
    })
})

describe('transfers between stockrooms', () => {
    const onLine: TransitionFacts = { ...deployable, onTransferOrderLine: true }
    const transferable = ['available', 'reserved', 'spare_pool', 'staging'] as const

    it.each(transferable)('lets Inventory take %s stock onto an open transfer order line', (from) => {
        expect(checkTransition(from, 'in_transfer', onLine)).toEqual({ allowed: true })
    })

    it('puts nothing in transfer that is not on an open line, the app\'s own moves included', () => {
        const reason = 'An asset is in transfer only while it is on an open transfer order line'
        expect(checkTransition('available', 'in_transfer', deployable)).toEqual({ allowed: false, reason })
        expect(checkTransition('reserved', 'in_transfer', { ...deployable, onTransferOrderLine: false })).toEqual({ allowed: false, reason })
    })

    it.each(['staged', 'shipped', 'in_service', 'pending_evaluation', 'pending_wipe', 'on_order'] as const)(
        'never transfers %s units',
        (from) => {
            expect(checkTransition(from, 'in_transfer', onLine)).toEqual({ allowed: false, reason: `Cannot move an asset from ${from} to in_transfer` })
        },
    )

    it.each(transferable)('lets an asset Inventory let go take back %s', (to) => {
        expect(checkTransition('in_transfer', to, { ...deployable, onTransferOrderLine: false })).toEqual({ allowed: true })
        expect(checkTransition('in_transfer', to, deployable)).toEqual({ allowed: true })
    })

    it.each(transferable)('keeps an asset in transfer, not %s, while Inventory still has it on an open line', (to) => {
        const reason = 'An asset leaves transfer only once Inventory lets it go from its transfer order line'
        expect(checkTransition('in_transfer', to, onLine)).toEqual({ allowed: false, reason })
    })

    it('refuses a hand-made form edit that frees a unit still on its way between stockrooms', () => {
        const inTransit = stageOf({ installStatus: '9', substatus: 'reserved' })
        expect(stageChangeRefusal(inTransit, 'available', onLine)).toBe(
            'An asset leaves transfer only once Inventory lets it go from its transfer order line',
        )
        expect(stageChangeRefusal(inTransit, 'available', { ...onLine, onTransferOrderLine: false })).toBeNull()
    })

    it.each(['staged', 'shipped', 'missing', 'pending_in_service'] as const)('takes an asset out of transfer into no other stage (%s)', (to) => {
        expect(checkTransition('in_transfer', to, deployable).allowed).toBe(false)
    })

    it('stays in transfer from Pending transfer to In transit / Reserved, whatever the line says', () => {
        const pending = stageOf({ installStatus: '6', substatus: 'pending_transfer' })
        const inTransit = stageOf({ installStatus: '9', substatus: 'reserved' })
        expect(stageChangeRefusal(pending, inTransit, onLine)).toBeNull()
        expect(stageChangeRefusal(inTransit, pending, deployable)).toBeNull()
    })

    it('checks a hand-made form edit into a transfer combination against the line', () => {
        expect(stageChangeRefusal('available', 'in_transfer', deployable)).toBe(
            'An asset is in transfer only while it is on an open transfer order line',
        )
        expect(stageChangeRefusal('available', 'in_transfer', onLine)).toBeNull()
    })

    it('needs no site or agreement, and never counts as deployed or billed', () => {
        const bare: TransitionFacts = { hasSite: false, hasAgreement: false, legalOwner: '', wipeEvidenceComplete: false, onTransferOrderLine: true }
        expect(checkTransition('available', 'in_transfer', bare)).toEqual({ allowed: true })
        expect(isDeployed('in_transfer')).toBe(false)
        expect(isBillable('in_transfer')).toBe(false)
        expect(billingChange('reserved', 'in_transfer', { today: '2026-11-09' })).toBeNull()
    })
})

describe('stageAfterTransfer', () => {
    const none: TransferContext = {
        onOrderLine: false,
        stagingTaskOpen: false,
        heldForCustomer: false,
        atStagingCentre: false,
        withdrawnBySourcing: false,
    }
    const sourced: TransferContext = { ...none, onOrderLine: true, stagingTaskOpen: true, heldForCustomer: true }

    it('stages a unit sourcing transferred to the staging centre once it is received there, as its Staging task waits', () => {
        expect(stageAfterTransfer({ ...sourced, atStagingCentre: true })).toBe('staging')
    })

    it('keeps a unit on an Order line reserved for it when its transfer was cancelled or deleted short of the staging centre', () => {
        expect(stageAfterTransfer(sourced)).toBe('reserved')
        expect(stageAfterTransfer({ ...sourced, withdrawnBySourcing: true })).toBe('reserved')
    })

    it('keeps a unit on an Order line without a Staging task reserved for the line, at the staging centre too', () => {
        expect(stageAfterTransfer({ ...sourced, stagingTaskOpen: false, atStagingCentre: true })).toBe('reserved')
        expect(stageAfterTransfer({ ...sourced, stagingTaskOpen: false })).toBe('reserved')
    })

    it("puts a Customer's spare back in its Spare pool, wherever Inventory left it", () => {
        expect(stageAfterTransfer({ ...none, heldForCustomer: true })).toBe('spare_pool')
        expect(stageAfterTransfer({ ...none, heldForCustomer: true, atStagingCentre: true })).toBe('spare_pool')
    })

    it("leaves the Provider's free stock available, as Inventory does", () => {
        expect(stageAfterTransfer(none)).toBe('available')
        expect(stageAfterTransfer({ ...none, stagingTaskOpen: true, atStagingCentre: true })).toBe('available')
    })

    it('only gives stages the lifecycle lets an asset take back from transfer', () => {
        const flags = [true, false]
        for (const onOrderLine of flags) {
            for (const stagingTaskOpen of flags) {
                for (const heldForCustomer of flags) {
                    for (const atStagingCentre of flags) {
                        const context = { onOrderLine, stagingTaskOpen, heldForCustomer, atStagingCentre, withdrawnBySourcing: false }
                        const to = stageAfterTransfer(context)
                        expect(checkTransition('in_transfer', to, deployable), to).toEqual({ allowed: true })
                        // Inventory sets it available first, in the same save (reserved for a line requested for a user).
                        expect(checkTransition('available', to, deployable), to).toEqual({ allowed: true })
                        expect(checkTransition('reserved', to, deployable), to).toEqual({ allowed: true })
                    }
                }
            }
        }
    })
})

describe('transferFellThrough', () => {
    const sourced: TransferContext = {
        onOrderLine: true,
        stagingTaskOpen: true,
        heldForCustomer: true,
        atStagingCentre: false,
        withdrawnBySourcing: false,
    }

    it('finds the transfer of a unit on an Order line fallen through when Inventory let it go short of the staging centre', () => {
        expect(transferFellThrough(sourced)).toBe(true)
        expect(transferFellThrough({ ...sourced, stagingTaskOpen: false })).toBe(true)
    })

    it('does not once the unit is received at the staging centre', () => {
        expect(transferFellThrough({ ...sourced, atStagingCentre: true })).toBe(false)
        expect(transferFellThrough({ ...sourced, atStagingCentre: true, stagingTaskOpen: false })).toBe(false)
    })

    it('leaves a transfer order sourcing is removing itself to sourcing, which puts the unit back', () => {
        expect(transferFellThrough({ ...sourced, withdrawnBySourcing: true })).toBe(false)
    })

    it('never holds for stock on no Order line: a transfer made by hand, or a unit Cancel order released', () => {
        expect(transferFellThrough({ ...sourced, onOrderLine: false })).toBe(false)
        expect(transferFellThrough({ ...sourced, onOrderLine: false, heldForCustomer: false })).toBe(false)
    })
})

describe('stageChangeRefusal', () => {
    it('lets a stage set by hand follow the lifecycle', () => {
        expect(stageChangeRefusal('staged', 'shipped', deployable)).toBeNull()
        expect(stageChangeRefusal('in_service', 'in_service', deployable)).toBeNull()
    })

    it('refuses a combination the app does not model, wherever the asset comes from', () => {
        const reason = 'This install status / substatus combination is not used by NaaS asset management'
        expect(stageChangeRefusal('available', null, deployable)).toBe(reason)
        expect(stageChangeRefusal(null, null, deployable)).toBe(reason)
    })

    it('gives the lifecycle reason for a move it does not allow', () => {
        expect(stageChangeRefusal('available', 'in_service', deployable)).toBe('Cannot move an asset from available to in_service')
        expect(stageChangeRefusal(null, 'available', deployable)).toBe(
            'The asset is in a stage this app does not model; an administrator must correct it',
        )
        expect(stageChangeRefusal('pending_disposal', 'disposed', deployable)).toBe(
            'Record wipe evidence before the asset leaves the provider',
        )
    })
})

describe('voidsWipeEvidence', () => {
    it("voids it when an asset enters staging from wherever it comes, as it takes a Customer's configuration", () => {
        for (const from of ['available', 'reserved', 'spare_pool', null] as const) {
            expect(voidsWipeEvidence(from, 'staging')).toBe(true)
        }
    })

    it('voids it when a unit in transfer goes into staging on arrival', () => {
        expect(voidsWipeEvidence('in_transfer', 'staging')).toBe(true)
        expect(voidsWipeEvidence('in_transfer', 'reserved')).toBe(false)
    })

    it('leaves it on every other move, and on staying in staging', () => {
        expect(voidsWipeEvidence('staging', 'staging')).toBe(false)
        expect(voidsWipeEvidence('staging', 'pending_evaluation')).toBe(false)
        expect(voidsWipeEvidence('pending_wipe', 'pending_disposal')).toBe(false)
        expect(voidsWipeEvidence('pending_evaluation', 'available')).toBe(false)
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

    it("gives in transfer a clause for each of Inventory's combinations, each carrying the base query", () => {
        expect(stagesQuery(['in_transfer'])).toBe('install_status=6^substatus=pending_transfer^NQinstall_status=9^substatus=reserved')
        expect(stagesQuery(['reserved', 'in_transfer'], 'model=m1', 'asset.')).toBe(
            'asset.install_status=6^asset.substatus=reserved^model=m1' +
                '^NQasset.install_status=6^asset.substatus=pending_transfer^model=m1' +
                '^NQasset.install_status=9^asset.substatus=reserved^model=m1',
        )
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
