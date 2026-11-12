import { beforeEach, describe, expect, it, vi } from 'vitest'
import { identifyAnyAsset, identifyAsset } from './asset-identifiers.ts'
import { platform } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const idOf = (identified: ReturnType<typeof identifyAsset>) => (identified && 'asset' in identified ? identified.asset.getUniqueValue() : identified)

beforeEach(() => {
    platform.reset()
    platform.tables.alm_hardware = [
        { sys_id: 'acme-sw', serial_number: 'FOC111', asset_tag: 'NAAS-1', x_daas_ham_customer_tag: 'SW-01', x_daas_ham_fleet: 'true' },
        { sys_id: 'globex-sw', serial_number: 'FOC222', asset_tag: 'NAAS-2', x_daas_ham_customer_tag: 'SW-01', x_daas_ham_fleet: 'true' },
        { sys_id: 'it-laptop', serial_number: 'FOC333', asset_tag: 'IT-9', x_daas_ham_customer_tag: '', x_daas_ham_fleet: 'false' },
        { sys_id: 'fleet-ap', serial_number: 'FOC333', asset_tag: 'NAAS-3', x_daas_ham_customer_tag: '', x_daas_ham_fleet: 'true' },
    ]
})

describe('identifyAsset', () => {
    it('refuses a Customer tag two Customers gave their switches, naming the fields that tell them apart', () => {
        expect(identifyAsset(' sw-01 ')).toEqual({ ambiguous: 'More than one asset has Customer tag sw-01: use its serial number or Provider tag instead' })
    })

    it('names the one fleet asset a serial or Provider tag belongs to', () => {
        expect(idOf(identifyAsset('FOC222'))).toBe('globex-sw')
        expect(idOf(identifyAsset('naas-1'))).toBe('acme-sw')
        expect(identifyAsset('UNKNOWN')).toBeNull()
    })
})

describe('identifyAnyAsset', () => {
    it('chooses the fleet asset over the Provider IT one that carries the same serial', () => {
        expect(idOf(identifyAnyAsset('FOC333'))).toBe('fleet-ap')
    })
})
