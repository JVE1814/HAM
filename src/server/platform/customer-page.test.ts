import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ALL_STAGES, type Stage } from '../domain/lifecycle.ts'
import { assetIn } from '../test-support/stored-asset.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const { customerEquipment } = await import('./customer-page.ts')
const { platform } = await import('../test-support/fake-glide.ts')

const DEPLOYED: readonly Stage[] = ['shipped', 'pending_in_service', 'in_service', 'temporary_deployment', 'pending_return']

let users = 0
function signIn(roles: string[]): void {
    const userId = `user${++users}`
    platform.user = { id: userId, name: '', company: 'cust1', roles, interactive: true }
    platform.tables.cmn_location = [{ sys_id: 'site1', company: 'cust1', x_daas_ham_site_contacts: `someone,${userId}` }]
}

/** One Asset in each stage, with `fields`: the stages of those the page lists. */
function listedStages(fields: Record<string, string>): Stage[] {
    platform.tables.alm_hardware = ALL_STAGES.map((stage) => ({ sys_id: stage, ...assetIn(stage, fields) }))
    return customerEquipment().map((asset) => asset.stage as Stage)
}

const OWN = { x_daas_ham_fleet: 'true', company: 'cust1', x_daas_ham_site: 'site1' }

beforeEach(() => platform.reset())

describe('customerEquipment', () => {
    it('lists the fleet assets at a Site or on the way there, from shipped to awaiting return', () => {
        signIn(['x_daas_ham.site_contact'])
        expect(listedStages(OWN).sort()).toEqual([...DEPLOYED].sort())
    })

    it("leaves out the Provider IT's hardware in use, such as laptops: an Asset whose Fleet flag is false or blank", () => {
        signIn(['x_daas_ham.asset_manager'])
        expect(listedStages({ ...OWN, x_daas_ham_fleet: 'false' })).toEqual([])
        expect(listedStages({ ...OWN, x_daas_ham_fleet: '' })).toEqual([])
    })

    it("keeps a deployed fleet unit that has lost its Agreement (a data gap) on its Customer's page", () => {
        signIn(['x_daas_ham.customer_admin'])
        expect(listedStages({ ...OWN, x_daas_ham_agreement: '' }).sort()).toEqual([...DEPLOYED].sort())
    })

    it("keeps every stage to the reader's Customer and Sites, which a before-query rule's filter would not reach", () => {
        signIn(['x_daas_ham.site_contact'])
        expect(listedStages({ ...OWN, company: 'cust9' })).toEqual([])
        expect(listedStages({ ...OWN, x_daas_ham_site: 'site9' })).toEqual([])
    })

    it('shows staff previewing the page every Customer', () => {
        signIn(['x_daas_ham.asset_manager'])
        expect(listedStages({ ...OWN, company: 'cust9', x_daas_ham_site: 'site9' }).sort()).toEqual([...DEPLOYED].sort())
    })
})
