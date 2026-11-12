import { describe, expect, it } from 'vitest'
import type { CustomerAsset } from '../../server/domain/rest-contracts'
import { bySite, equipmentCount } from './sites'

const asset = (id: string, siteId: string): CustomerAsset => ({ id, serial: id, customerTag: '', model: 'M', site: siteId, siteId, stage: 'in_service', refreshDue: '' })

const ids = (assets: readonly CustomerAsset[] | undefined) => assets?.map((a) => a.id)

describe('bySite', () => {
    it('groups the devices by Site, keeping the order they came in', () => {
        const sites = bySite([asset('a', 's1'), asset('b', 's2'), asset('c', 's1')])
        expect([...sites.keys()]).toEqual(['s1', 's2'])
        expect(ids(sites.get('s1'))).toEqual(['a', 'c'])
        expect(ids(sites.get('s2'))).toEqual(['b'])
    })

    it("keeps the devices with no Site under ''", () => {
        const sites = bySite([asset('a', ''), asset('b', 's1'), asset('c', '')])
        expect(ids(sites.get(''))).toEqual(['a', 'c'])
    })

    it('gives an empty map for no devices', () => {
        expect(bySite([]).size).toBe(0)
    })

    it('does not change the list it was given', () => {
        const given = [asset('a', 's1'), asset('b', 's2'), asset('c', 's1')]
        bySite(given)
        expect(ids(given)).toEqual(['a', 'b', 'c'])
    })
})

describe('equipmentCount', () => {
    it('writes a whole list as its count', () => {
        expect(equipmentCount(12, false)).toBe('12')
    })

    it('writes a cut list as its count and a plus', () => {
        expect(equipmentCount(5000, true)).toBe('5000+')
    })
})
