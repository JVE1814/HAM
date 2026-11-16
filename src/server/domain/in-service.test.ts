import { describe, expect, it } from 'vitest'
import { chooseSubscriptionLine, decideInService, firstSeenSinceInstall, seenSourceOf } from './in-service'

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

    it('goes live from the first sighting since the install, not from a later one', () => {
        expect(decideInService({ ...installed, firstSeenAt: 1_200, lastSeenAt: 1_500 })).toEqual({ goesLive: true, at: 1_200, stage: 'in_service' })
    })

    it('passes over a first sighting kept from before the install', () => {
        expect(decideInService({ ...installed, firstSeenAt: 500, lastSeenAt: 1_500 })).toMatchObject({ goesLive: true, at: 1_500 })
        expect(decideInService({ ...installed, firstSeenAt: 500, lastSeenAt: 900 })).toEqual({ goesLive: false, reason: 'not seen since install' })
    })

    it('waits for the install to be completed', () => {
        expect(decideInService({ ...installed, installCompletedAt: undefined, lastSeenAt: 1_500 })).toEqual({ goesLive: false, reason: 'install not completed' })
    })

    it('ignores assets that are not pending in service', () => {
        expect(decideInService({ ...installed, stage: 'in_service', lastSeenAt: 1_500 })).toEqual({ goesLive: false, reason: 'not pending in service' })
    })
})

describe('firstSeenSinceInstall', () => {
    it('keeps the stored first sighting however far the last one has moved on', () => {
        expect(firstSeenSinceInstall({ installCompletedAt: 1_000, firstSeenAt: 1_000, lastSeenAt: 9_000 })).toBe(1_000)
    })

    it('is the last sighting when none since the install is stored', () => {
        expect(firstSeenSinceInstall({ installCompletedAt: 1_000, lastSeenAt: 1_500 })).toBe(1_500)
        expect(firstSeenSinceInstall({ installCompletedAt: 1_000, firstSeenAt: 500, lastSeenAt: 1_500 })).toBe(1_500)
    })

    it('is none while the Asset is not seen since its install, or has no install time', () => {
        expect(firstSeenSinceInstall({ installCompletedAt: 1_000, firstSeenAt: 500, lastSeenAt: 900 })).toBeUndefined()
        expect(firstSeenSinceInstall({ installCompletedAt: 1_000 })).toBeUndefined()
        expect(firstSeenSinceInstall({ firstSeenAt: 1_200, lastSeenAt: 1_500 })).toBeUndefined()
    })
})

describe('chooseSubscriptionLine', () => {
    const liveOn = '2026-08-10'
    const lines = [
        { id: 'ended-pkg', lineType: 'site_package' as const, siteId: 'site-a', deviceClass: '', status: 'ended' as const },
        { id: 'pkg-a', lineType: 'site_package' as const, siteId: 'site-a', deviceClass: '', status: 'active' as const },
        { id: 'switches', lineType: 'device_class' as const, siteId: '', deviceClass: 'switch', status: 'pending' as const },
    ]

    it('prefers the site package for the asset site', () => {
        expect(chooseSubscriptionLine(lines, { siteId: 'site-a', deviceClass: 'switch', liveOn })).toBe('pkg-a')
    })

    it('falls back to the device-class line', () => {
        expect(chooseSubscriptionLine(lines, { siteId: 'site-b', deviceClass: 'switch', liveOn })).toBe('switches')
    })

    it('finds nothing when no open line fits', () => {
        expect(chooseSubscriptionLine(lines, { siteId: 'site-b', deviceClass: 'ap', liveOn })).toBeNull()
    })

    describe('with a site-less and a Site-specific line for the device class', () => {
        const siteLess = { id: 'switches', lineType: 'device_class' as const, siteId: '', deviceClass: 'switch', status: 'active' as const }
        const siteA = { id: 'switches-a', lineType: 'device_class' as const, siteId: 'site-a', deviceClass: 'switch', status: 'active' as const }

        it('chooses the line for the asset site when it is read after the site-less one', () => {
            expect(chooseSubscriptionLine([siteLess, siteA], { siteId: 'site-a', deviceClass: 'switch', liveOn })).toBe('switches-a')
        })

        it('chooses the line for the asset site when it is read before the site-less one', () => {
            expect(chooseSubscriptionLine([siteA, siteLess], { siteId: 'site-a', deviceClass: 'switch', liveOn })).toBe('switches-a')
        })

        it('chooses the site-less line for an asset at another site, in either order', () => {
            expect(chooseSubscriptionLine([siteA, siteLess], { siteId: 'site-b', deviceClass: 'switch', liveOn })).toBe('switches')
            expect(chooseSubscriptionLine([siteLess, siteA], { siteId: 'site-b', deviceClass: 'switch', liveOn })).toBe('switches')
        })

        it('passes over an ended line for the asset site', () => {
            expect(chooseSubscriptionLine([{ ...siteA, status: 'ended' }, siteLess], { siteId: 'site-a', deviceClass: 'switch', liveOn })).toBe('switches')
        })

        it('never gives a Site-specific line to an asset without a site', () => {
            expect(chooseSubscriptionLine([siteA], { siteId: '', deviceClass: 'switch', liveOn })).toBeNull()
        })
    })

    describe('with lines of the device class that ended or start after the go-live', () => {
        const live = { siteId: 'site-a', deviceClass: 'switch', liveOn: '2026-08-10' }
        const line = { lineType: 'device_class' as const, siteId: '', deviceClass: 'switch', status: 'active' as const }
        const ended = { ...line, id: 'h1', start: '2026-01-01', end: '2026-06-30' }
        const current = { ...line, id: 'h2', start: '2026-07-01' }
        const later = { ...line, id: 'next-year', start: '2027-01-01' }

        it('passes over a line whose end date is before the go-live, though not set ended', () => {
            expect(chooseSubscriptionLine([ended, current], live)).toBe('h2')
            expect(chooseSubscriptionLine([current, ended], live)).toBe('h2')
        })

        it('still chooses a line that ends on the go-live day', () => {
            expect(chooseSubscriptionLine([{ ...ended, end: '2026-08-10' }], live)).toBe('h1')
        })

        it('prefers a started line to one that starts later, and takes the later one when it is all there is', () => {
            expect(chooseSubscriptionLine([later, current], live)).toBe('h2')
            expect(chooseSubscriptionLine([later], live)).toBe('next-year')
        })

        it('keeps a line for the asset site before a site-less one that has started', () => {
            expect(chooseSubscriptionLine([current, { ...later, id: 'site-a-later', siteId: 'site-a' }], live)).toBe('site-a-later')
        })
    })
})

describe('seenSourceOf', () => {
    it("takes Discovery's own sightings as discovery and any other source's as a connector's", () => {
        expect(seenSourceOf('ServiceNow')).toBe('discovery')
        expect(seenSourceOf('SG-Meraki')).toBe('connector')
        expect(seenSourceOf('')).toBe('connector')
    })
})
