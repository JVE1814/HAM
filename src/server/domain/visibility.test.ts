import { describe, expect, it } from 'vitest'
import { resolveVisibility, visibilityFilter } from './visibility'

const roles = (...held: string[]) => (role: string) => held.includes(role)

describe('resolveVisibility', () => {
    it('gives provider staff with any broad role the whole installed base', () => {
        expect(resolveVisibility(roles('x_daas_ham.asset_manager', 'x_daas_ham.inventory_tech'))).toBe('everything')
        expect(resolveVisibility(roles('x_daas_ham.noc'))).toBe('everything')
        expect(resolveVisibility(roles('x_daas_ham.field_tech'))).toBe('everything')
    })

    it('limits inventory techs without a broader role to their stockrooms', () => {
        expect(resolveVisibility(roles('x_daas_ham.inventory_tech'))).toBe('assigned_stockrooms')
    })

    it('limits customer admins to their own customer', () => {
        expect(resolveVisibility(roles('x_daas_ham.customer_admin'))).toBe('own_customer')
    })

    it('limits site contacts to their own sites unless they are also a customer admin', () => {
        expect(resolveVisibility(roles('x_daas_ham.site_contact'))).toBe('own_sites')
        expect(resolveVisibility(roles('x_daas_ham.site_contact', 'x_daas_ham.customer_admin'))).toBe('own_customer')
    })

    it('leaves everyone else to the platform ACLs', () => {
        expect(resolveVisibility(roles('itil'))).toBe('unscoped')
    })
})


describe('visibilityFilter', () => {
    const ids = {
        customerId: 'cust1',
        stockroomIds: () => ['sr1', 'sr2'],
        siteIds: () => ['site1'],
    }
    const assetFields = { stockroom: 'stockroom', customer: 'company', site: 'x_daas_ham_site' }

    it('adds no filter for staff who see everything or users left to ACLs', () => {
        expect(visibilityFilter('everything', assetFields, ids)).toBeNull()
        expect(visibilityFilter('unscoped', assetFields, ids)).toBeNull()
    })

    it('filters by the scoping field for each restricted scope', () => {
        expect(visibilityFilter('assigned_stockrooms', assetFields, ids)).toBe('stockroomINsr1,sr2')
        expect(visibilityFilter('own_customer', assetFields, ids)).toBe('company=cust1')
        expect(visibilityFilter('own_sites', assetFields, ids)).toBe('x_daas_ham_siteINsite1')
    })

    it('shows nothing when the user has no stockrooms, sites or customer', () => {
        const none = { customerId: '', stockroomIds: () => [], siteIds: () => [] }
        expect(visibilityFilter('assigned_stockrooms', assetFields, none)).toBe('sys_id=-1')
        expect(visibilityFilter('own_customer', assetFields, none)).toBe('sys_id=-1')
        expect(visibilityFilter('own_sites', assetFields, none)).toBe('sys_id=-1')
    })

    it('leaves inventory techs unfiltered on tables without a stockroom', () => {
        expect(visibilityFilter('assigned_stockrooms', { customer: 'customer' }, ids)).toBeNull()
    })

    it('hides tables without a customer field from external users', () => {
        expect(visibilityFilter('own_customer', { stockroom: 'stockroom' }, ids)).toBe('sys_id=-1')
        expect(visibilityFilter('own_sites', { customer: 'customer' }, ids)).toBe('sys_id=-1')
    })

    it('supports an either-or stockroom filter for transfers between stockrooms', () => {
        expect(visibilityFilter('assigned_stockrooms', { stockroom: ['from_stockroom', 'to_stockroom'] }, ids)).toBe(
            'from_stockroomINsr1,sr2^ORto_stockroomINsr1,sr2',
        )
    })
})
