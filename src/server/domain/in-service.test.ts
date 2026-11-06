import { describe, expect, it } from 'vitest'
import { chooseSubscriptionLine, decideInService } from './in-service'

describe('decideInService', () => {
    const installed = { stage: 'pending_in_service' as const, installCompletedAt: 1_000, temporary: false }

    it('puts an installed asset in service when monitoring sees it after the install', () => {
        expect(decideInService({ ...installed, lastSeenAt: 1_500 })).toEqual({ goesLive: true, at: 1_500, stage: 'in_service' })
    })

    it('uses the temporary-deployment stage for temporary orders', () => {
        expect(decideInService({ ...installed, temporary: true, lastSeenAt: 1_500 })).toMatchObject({ stage: 'temporary_deployment' })
    })

    it('waits until the asset is seen after its install completed', () => {
        expect(decideInService({ ...installed, lastSeenAt: 900 })).toEqual({ goesLive: false, reason: 'not seen since install' })
        expect(decideInService({ ...installed, lastSeenAt: undefined })).toEqual({ goesLive: false, reason: 'not seen since install' })
    })

    it('waits for the install to be completed', () => {
        expect(decideInService({ ...installed, installCompletedAt: undefined, lastSeenAt: 1_500 })).toEqual({ goesLive: false, reason: 'install not completed' })
    })

    it('ignores assets that are not pending in service', () => {
        expect(decideInService({ ...installed, stage: 'in_service', lastSeenAt: 1_500 })).toEqual({ goesLive: false, reason: 'not pending in service' })
    })
})

describe('chooseSubscriptionLine', () => {
    const lines = [
        { id: 'ended-pkg', lineType: 'site_package' as const, siteId: 'site-a', deviceClass: '', status: 'ended' as const },
        { id: 'pkg-a', lineType: 'site_package' as const, siteId: 'site-a', deviceClass: '', status: 'active' as const },
        { id: 'switches', lineType: 'device_class' as const, siteId: '', deviceClass: 'switch', status: 'pending' as const },
    ]

    it('prefers the site package for the asset site', () => {
        expect(chooseSubscriptionLine(lines, { siteId: 'site-a', deviceClass: 'switch' })).toBe('pkg-a')
    })

    it('falls back to the device-class line', () => {
        expect(chooseSubscriptionLine(lines, { siteId: 'site-b', deviceClass: 'switch' })).toBe('switches')
    })

    it('finds nothing when no open line fits', () => {
        expect(chooseSubscriptionLine(lines, { siteId: 'site-b', deviceClass: 'ap' })).toBeNull()
    })
})
