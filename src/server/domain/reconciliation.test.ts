import { describe, expect, it } from 'vitest'
import {
    outOfUseExceptionsQuery,
    outsideFleetExceptionsQuery,
    reconcileAsset,
    seenWithoutFleetAssetQuery,
    stillSeenWithoutFleetAssetQuery,
} from './reconciliation'
import { recordMatches as matches } from '../test-support/encoded-query'

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


/** A network-gear CI at a customer Site, by the Asset it points at: none, or one with this Fleet flag on its hardware record. */
const FLAG = 'asset.ref_alm_hardware.x_daas_ham_fleet'
const AT_SITE = { 'location.x_daas_ham_is_site': 'true' }
const ciOn = (fleet: string | null, where: Record<string, string> = AT_SITE) => (fleet === null ? { asset: '', ...where } : { asset: 'a1', [FLAG]: fleet, ...where })

describe('seenWithoutFleetAssetQuery', () => {
    const query = seenWithoutFleetAssetQuery()

    it('finds a CI at a customer Site that points at no Asset, or at one outside the fleet, flag false or blank (ADR 0016)', () => {
        expect(matches(query, ciOn(null))).toBe(true)
        expect(matches(query, ciOn('false'))).toBe(true)
        expect(matches(query, ciOn(''))).toBe(true)
    })

    it("leaves out a CI on a fleet asset, read through the Asset's hardware record: alm_asset itself has no Fleet flag", () => {
        // The sample has the flag on the hardware record only: read as asset.x_daas_ham_fleet it is blank, as on the instance.
        expect(matches(query, ciOn('true'))).toBe(false)
    })

    it('keeps to CIs at a customer Site, or in a room or building of one', () => {
        const room = { 'location.x_daas_ham_is_site': 'false', 'location.parent.x_daas_ham_is_site': 'true' }
        const rack = { 'location.x_daas_ham_is_site': 'false', 'location.parent.x_daas_ham_is_site': 'false', 'location.parent.parent.x_daas_ham_is_site': 'true' }
        const elsewhere = { 'location.x_daas_ham_is_site': 'false', 'location.parent.x_daas_ham_is_site': '' }
        for (const fleet of [null, 'false', '']) {
            expect(matches(query, ciOn(fleet, room)), String(fleet)).toBe(true)
            expect(matches(query, ciOn(fleet, rack)), String(fleet)).toBe(true)
            expect(matches(query, ciOn(fleet, elsewhere)), String(fleet)).toBe(false)
            expect(matches(query, ciOn(fleet, {})), String(fleet)).toBe(false)
        }
        expect(matches(query, ciOn('true', room))).toBe(false)
    })
})

describe('stillSeenWithoutFleetAssetQuery', () => {
    it('keeps the reported CIs the seen-without-asset condition still matches, discovered recently or not', () => {
        const query = stillSeenWithoutFleetAssetQuery(['ci1', 'ci2', 'ci1']) ?? ''
        const longAgo = { last_discovered: '2020-01-01 00:00:00' }
        expect(matches(query, { sys_id: 'ci1', ...ciOn(null), ...longAgo })).toBe(true)
        expect(matches(query, { sys_id: 'ci2', ...ciOn('false') })).toBe(true)
        expect(matches(query, { sys_id: 'ci3', ...ciOn(null) })).toBe(false)
        expect(matches(query, { sys_id: 'ci1', ...ciOn('true') })).toBe(false)
        expect(matches(query, { sys_id: 'ci1', ...ciOn(null, {}) })).toBe(false)
    })

    it('gives no query for no CI, which would match every CI at a Site', () => {
        expect(stillSeenWithoutFleetAssetQuery([])).toBeNull()
        expect(stillSeenWithoutFleetAssetQuery([''])).toBeNull()
    })
})

describe('outsideFleetExceptionsQuery', () => {
    const query = outsideFleetExceptionsQuery(['unseen', 'serial_mismatch']) ?? ''
    const raised = { status: 'open', exception_type: 'unseen', asset: 'a1', 'asset.x_daas_ham_fleet': 'false' }

    it('finds the open exceptions of the types on an Asset outside the fleet, flag false or blank', () => {
        expect(matches(query, raised)).toBe(true)
        expect(matches(query, { ...raised, exception_type: 'serial_mismatch' })).toBe(true)
        // A row from before the column, or an Asset since deleted: the reference is left, the flag reads blank.
        expect(matches(query, { ...raised, 'asset.x_daas_ham_fleet': '' })).toBe(true)
    })

    it('leaves the exceptions of a fleet asset to the daily reconciliation, and those resolved, of another type or on no Asset', () => {
        expect(matches(query, { ...raised, 'asset.x_daas_ham_fleet': 'true' })).toBe(false)
        expect(matches(query, { ...raised, status: 'resolved' })).toBe(false)
        expect(matches(query, { ...raised, exception_type: 'rack_overlap' })).toBe(false)
        expect(matches(query, { ...raised, asset: '', 'asset.x_daas_ham_fleet': '' })).toBe(false)
    })

    it('gives no query for no types, which would match every type', () => {
        expect(outsideFleetExceptionsQuery([])).toBeNull()
    })
})

describe('outOfUseExceptionsQuery', () => {
    const query = outOfUseExceptionsQuery(['unseen', 'serial_mismatch']) ?? ''
    const onAsset = (installStatus: string, substatus: string, fleet = 'true') => ({
        status: 'open',
        exception_type: 'unseen',
        asset: 'a1',
        'asset.install_status': installStatus,
        'asset.substatus': substatus,
        'asset.x_daas_ham_fleet': fleet,
    })

    it('finds the open exceptions of the types on a fleet asset out of use: pending return, in stock or retired', () => {
        expect(matches(query, onAsset('1', 'pending_return'))).toBe(true)
        expect(matches(query, onAsset('6', 'available'))).toBe(true)
        expect(matches(query, onAsset('7', 'disposed'))).toBe(true)
        expect(matches(query, { ...onAsset('7', 'disposed'), exception_type: 'serial_mismatch' })).toBe(true)
    })

    it('leaves those of an Asset in use to the comparison, those outside the fleet to their own query, and those resolved or of another type', () => {
        expect(matches(query, onAsset('1', ''))).toBe(false)
        expect(matches(query, onAsset('1', 'temporary_deployment'))).toBe(false)
        expect(matches(query, onAsset('7', 'disposed', 'false'))).toBe(false)
        expect(matches(query, { ...onAsset('7', 'disposed'), status: 'resolved' })).toBe(false)
        expect(matches(query, { ...onAsset('7', 'disposed'), exception_type: 'rack_overlap' })).toBe(false)
    })

    it('gives no query for no types, which would match every type', () => {
        expect(outOfUseExceptionsQuery([])).toBeNull()
    })
})
