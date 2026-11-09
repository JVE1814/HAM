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

    describe('with a site-less and a Site-specific line for the device class', () => {
        const siteLess = { id: 'switches', lineType: 'device_class' as const, siteId: '', deviceClass: 'switch', status: 'active' as const }
        const siteA = { id: 'switches-a', lineType: 'device_class' as const, siteId: 'site-a', deviceClass: 'switch', status: 'active' as const }

        it('chooses the line for the asset site when it is read after the site-less one', () => {
            expect(chooseSubscriptionLine([siteLess, siteA], { siteId: 'site-a', deviceClass: 'switch' })).toBe('switches-a')
        })

        it('chooses the line for the asset site when it is read before the site-less one', () => {
            expect(chooseSubscriptionLine([siteA, siteLess], { siteId: 'site-a', deviceClass: 'switch' })).toBe('switches-a')
        })

        it('chooses the site-less line for an asset at another site, in either order', () => {
            expect(chooseSubscriptionLine([siteA, siteLess], { siteId: 'site-b', deviceClass: 'switch' })).toBe('switches')
            expect(chooseSubscriptionLine([siteLess, siteA], { siteId: 'site-b', deviceClass: 'switch' })).toBe('switches')
        })

        it('passes over an ended line for the asset site', () => {
            expect(chooseSubscriptionLine([{ ...siteA, status: 'ended' }, siteLess], { siteId: 'site-a', deviceClass: 'switch' })).toBe('switches')
        })

        it('never gives a Site-specific line to an asset without a site', () => {
            expect(chooseSubscriptionLine([siteA], { siteId: '', deviceClass: 'switch' })).toBeNull()
        })
    })
})
