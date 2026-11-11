import { describe, expect, it } from 'vitest'
import { CUSTOMER_CONTACTS, PROVIDER_STAFF, RACK_PAGE_USERS } from './roles'

describe('RACK_PAGE_USERS', () => {
    it('opens the rack page to every provider-staff role and every Customer contact', () => {
        expect(RACK_PAGE_USERS).toEqual([...PROVIDER_STAFF, ...CUSTOMER_CONTACTS])
    })
})
