import { describe, expect, it } from 'vitest'
import { reconcileAsset } from './reconciliation'

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
