import { describe, expect, it } from 'vitest'
import { customerEquipmentQuery } from './customer-page'
import { ALL_STAGES, type Stage } from './lifecycle'
import { recordMatches as matches } from '../test-support/encoded-query'
import { assetIn, type SampleRecord } from '../test-support/stored-asset'

describe('customerEquipmentQuery', () => {
    const DEPLOYED: readonly Stage[] = ['shipped', 'pending_in_service', 'in_service', 'temporary_deployment', 'pending_return']
    /** The stages in which an Asset with these fields is listed. */
    const listed = (query: string, fields: SampleRecord) => ALL_STAGES.filter((stage) => matches(query, assetIn(stage, fields)))

    it('lists the fleet assets at a Site or on the way there, from shipped to awaiting return', () => {
        expect(listed(customerEquipmentQuery(null), { x_daas_ham_fleet: 'true' })).toEqual(DEPLOYED)
    })

    it("leaves out the Provider IT's hardware in use, such as laptops: an Asset whose Fleet flag is false or blank", () => {
        expect(listed(customerEquipmentQuery(null), { x_daas_ham_fleet: 'false' })).toEqual([])
        expect(listed(customerEquipmentQuery(null), { x_daas_ham_fleet: '' })).toEqual([])
    })

    it('keeps a deployed fleet unit that has lost its Agreement (a data gap) on its Customer\'s page', () => {
        expect(listed(customerEquipmentQuery(null), { x_daas_ham_fleet: 'true', x_daas_ham_agreement: '' })).toEqual(DEPLOYED)
    })

    it("keeps every stage to the reader's filter, which a before-query rule's filter would not reach", () => {
        const query = customerEquipmentQuery('company=cust1^x_daas_ham_siteINsite1')
        const fleet = { x_daas_ham_fleet: 'true', company: 'cust1', x_daas_ham_site: 'site1' }
        expect(listed(query, fleet)).toEqual(DEPLOYED)
        expect(listed(query, { ...fleet, company: 'cust9' })).toEqual([])
        expect(listed(query, { ...fleet, x_daas_ham_site: 'site9' })).toEqual([])
        expect(listed(query, { ...fleet, x_daas_ham_fleet: 'false' })).toEqual([])
    })
})
