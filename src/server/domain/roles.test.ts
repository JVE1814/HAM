import { describe, expect, it } from 'vitest'
import { BROAD_STAFF, CUSTOMER_CONTACTS, PROVIDER_STAFF, RACK_PAGE_USERS, ROLE } from './roles'

describe('RACK_PAGE_USERS', () => {
    it('opens the rack page to every provider-staff role and every Customer contact', () => {
        expect(RACK_PAGE_USERS).toEqual([...PROVIDER_STAFF, ...CUSTOMER_CONTACTS])
    })
})

describe('BROAD_STAFF', () => {
    it('is every provider-staff role but the inventory tech, who reads only their stockrooms', () => {
        expect(BROAD_STAFF).toEqual(PROVIDER_STAFF.filter((role) => role !== ROLE.inventoryTech))
    })
})
