import { describe, expect, it } from 'vitest'
import { customerEquipmentQuery } from './customer-page'
import { fleetCondition } from './fleet'
import { DEPLOYED_STAGES } from './lifecycle'

describe('customerEquipmentQuery', () => {
    const clauses = customerEquipmentQuery(null).split('^NQ')

    it('lists every deployed stage, from shipped to awaiting return', () => {
        expect(clauses).toHaveLength(DEPLOYED_STAGES.length)
        expect(clauses[0]).toContain('install_status=9^substatus=shipped_to_site')
        expect(clauses.at(-1)).toContain('install_status=1^substatus=pending_return')
    })

    it("keeps only fleet assets in each stage: the Provider IT's hardware in use, such as laptops, is left out", () => {
        for (const clause of clauses) expect(clause).toMatch(new RegExp(`\\^${fleetCondition()}$`))
    })

    it('keeps a deployed fleet unit that has lost its Agreement (a data gap) on its Customer\'s page', () => {
        expect(customerEquipmentQuery(null)).not.toContain('x_daas_ham_agreement')
    })

    it("puts the reader's filter in every stage's clause, which a before-query rule's filter would not reach", () => {
        const scoped = customerEquipmentQuery('company=cust1^x_daas_ham_siteINsite1').split('^NQ')
        expect(scoped).toHaveLength(DEPLOYED_STAGES.length)
        for (const clause of scoped) expect(clause).toContain('^company=cust1^x_daas_ham_siteINsite1')
    })
})
