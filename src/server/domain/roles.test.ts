import { describe, expect, it } from 'vitest'
import { BROAD_STAFF, CUSTOMER_CONTACTS, PROVIDER_STAFF, RACK_PAGE_USERS, ROLE } from './roles'
import { BILLING_PULL_READERS } from './billing'
import { DEVICE_EVENT_SENDERS } from './device-events'

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

describe('the machine roles', () => {
    it('are one for each integration: no role both posts device events and pulls billing', () => {
        expect(BILLING_PULL_READERS).toEqual([ROLE.finance, ROLE.billingReader])
        expect(DEVICE_EVENT_SENDERS).toContain(ROLE.integration)
        expect(DEVICE_EVENT_SENDERS.filter((role) => BILLING_PULL_READERS.includes(role))).toEqual([])
    })
})
