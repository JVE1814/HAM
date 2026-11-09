import { describe, expect, it } from 'vitest'
import {
    outsideFleetExceptionsQuery,
    reconcileAsset,
    reconcileRack,
    seenWithoutFleetAssetQuery,
    stillSeenWithoutFleetAssetQuery,
} from './reconciliation'

const DAY = 86_400_000
const now = Date.parse('2026-11-07T12:00:00Z')
const healthy = {
    serial: 'FOC1',
    siteId: 'hq',
    lastSeenAt: now - DAY,
    ci: { serial: 'FOC1', locationIds: ['hq-mdf', 'hq', 'london'] },
}

describe('reconcileAsset', () => {
    it('finds nothing wrong with a recently seen asset that matches its CI', () => {
        expect(reconcileAsset(healthy, now, 7)).toEqual([])
    })

    it('flags assets not seen for longer than the threshold, or never', () => {
        expect(reconcileAsset({ ...healthy, lastSeenAt: now - 8 * DAY }, now, 7)).toEqual(['unseen'])
        expect(reconcileAsset({ ...healthy, lastSeenAt: undefined }, now, 7)).toEqual(['unseen'])
    })

    it('flags a CI whose serial or site disagrees with the asset', () => {
        expect(reconcileAsset({ ...healthy, ci: { serial: 'FOC9', locationIds: ['hq'] } }, now, 7)).toEqual(['serial_mismatch'])
        expect(reconcileAsset({ ...healthy, ci: { serial: 'foc1 ', locationIds: ['store-idf', 'store', 'london'] } }, now, 7)).toEqual([
            'location_mismatch',
        ])
    })

    it('accepts a CI located at the site itself or anywhere inside it', () => {
        expect(reconcileAsset({ ...healthy, ci: { serial: 'FOC1', locationIds: ['hq', 'london', ''] } }, now, 7)).toEqual([])
        expect(reconcileAsset({ ...healthy, ci: { serial: 'FOC1', locationIds: ['hq-idf2', 'hq-b2', 'hq'] } }, now, 7)).toEqual([])
    })

    it('does not judge the location of a CI without one', () => {
        expect(reconcileAsset({ ...healthy, ci: { serial: 'FOC1', locationIds: ['', '', ''] } }, now, 7)).toEqual([])
    })

    it('does not compare against a CI the asset does not have', () => {
        expect(reconcileAsset({ ...healthy, ci: undefined }, now, 7)).toEqual([])
    })
})

describe('reconcileRack', () => {
    const rack = { units: 42, powerCapacityW: 1000 }
    const placed = [
        { assetId: 'sw1', ruStart: 40, height: 1, face: 'front' as const, powerW: 350 },
        { assetId: 'fw1', ruStart: 30, height: 2, face: 'front' as const, powerW: 250 },
    ]

    it('finds nothing wrong with a rack whose devices fit and draw within its capacity', () => {
        expect(reconcileRack(rack, placed)).toEqual([])
    })

    it('raises an overlap naming each pair that shares units', () => {
        const twoSaves = [
            ...placed,
            { assetId: 'sw2', ruStart: 31, height: 1, face: 'front' as const },
            { assetId: 'sw3', ruStart: 31, height: 1, face: 'front' as const },
        ]
        const detail = ['fw1 and sw2', 'fw1 and sw3', 'sw2 and sw3'].map((pair) => `${pair} share rack unit 31 (front)`).join('; ')
        expect(reconcileRack(rack, twoSaves)).toEqual([{ type: 'rack_overlap', detail }])
    })

    it('raises the power budget once typical power is over the capacity, counting both faces', () => {
        expect(reconcileRack(rack, [...placed, { assetId: 'pdu', ruStart: 30, height: 1, face: 'rear', powerW: 400 }])).toEqual([])
        expect(reconcileRack(rack, [...placed, { assetId: 'pdu', ruStart: 30, height: 1, face: 'rear', powerW: 401 }])).toEqual([
            { type: 'rack_over_power', detail: "Typical power 1001 W is over the rack's 1000 W" },
        ])
    })

    it('does not judge the power of a rack without a recorded capacity', () => {
        const big = { assetId: 'big', ruStart: 1, height: 1, face: 'front' as const, powerW: 5000 }
        expect(reconcileRack({ units: 42, powerCapacityW: 0 }, [...placed, big])).toEqual([])
    })

    it('raises both when two saves overlap and take the rack over its budget', () => {
        const both = [...placed, { assetId: 'sw2', ruStart: 40, height: 1, face: 'front' as const, powerW: 500 }]
        expect(reconcileRack(rack, both).map((found) => found.type)).toEqual(['rack_overlap', 'rack_over_power'])
    })

    it('finds nothing in an empty rack', () => {
        expect(reconcileRack(rack, [])).toEqual([])
    })
})

describe('seenWithoutFleetAssetQuery', () => {
    const query = seenWithoutFleetAssetQuery()

    it('finds CIs pointing at no Asset or at one outside the fleet, through the hardware table (ADR 0016)', () => {
        const hardware = 'asset.ref_alm_hardware.x_daas_ham_fleet'
        expect(query.startsWith(`assetISEMPTY^OR${hardware}=false^OR${hardware}ISEMPTY^`)).toBe(true)
        // A CI's asset is an alm_asset reference: a condition on asset.x_daas_ham_fleet would be ignored.
        expect(query).not.toMatch(/(^|\^|OR)asset\.x_daas_ham_fleet/)
    })

    it('keeps to CIs at a customer Site, or in a room or building of one', () => {
        expect(query.endsWith('^location.x_daas_ham_is_site=true^ORlocation.parent.x_daas_ham_is_site=true^ORlocation.parent.parent.x_daas_ham_is_site=true')).toBe(true)
        expect(query).not.toContain('^NQ')
    })
})

describe('stillSeenWithoutFleetAssetQuery', () => {
    it('keeps the reported CIs the seen-without-asset condition still matches, discovered recently or not', () => {
        expect(stillSeenWithoutFleetAssetQuery(['ci1', 'ci2', 'ci1'])).toBe(`sys_idINci1,ci2^${seenWithoutFleetAssetQuery()}`)
        expect(stillSeenWithoutFleetAssetQuery(['ci1'])).not.toContain('last_discovered')
    })

    it('gives no query for no CI, which would match every CI at a Site', () => {
        expect(stillSeenWithoutFleetAssetQuery([])).toBeNull()
        expect(stillSeenWithoutFleetAssetQuery([''])).toBeNull()
    })
})

describe('outsideFleetExceptionsQuery', () => {
    it('finds open exceptions of the types on an Asset outside the fleet, flag false or blank', () => {
        expect(outsideFleetExceptionsQuery(['unseen', 'serial_mismatch'])).toBe(
            'status=open^exception_typeINunseen,serial_mismatch^assetISNOTEMPTY^asset.x_daas_ham_fleet=false^ORasset.x_daas_ham_fleetISEMPTY',
        )
        expect(outsideFleetExceptionsQuery(['unseen'])).not.toContain('^NQ')
    })
})
