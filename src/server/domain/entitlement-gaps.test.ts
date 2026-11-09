import { describe, expect, it } from 'vitest'
import { assessOrder, type CatalogEntryView, type EntitlementContext } from './entitlement'

/*
 * The catalog entries an Order counts (entitlement `isCurrent`): an active entry within its validity on the day. The
 * expired side is in entitlement.test.ts; these are the inactive and not-yet-valid sides, and the edges of the window.
 */

const today = '2026-11-06'

function contextWith(...catalog: CatalogEntryView[]): EntitlementContext {
    return { catalog, quantities: [], usage: [], today }
}

const switchLine = { lines: [{ modelId: 'c9300', deviceClass: 'switch', quantity: 1 }] }
const templateOrder = { siteTemplateId: 'small-branch', lines: [{ modelId: 'c9300', deviceClass: 'switch', quantity: 1, fromSiteTemplate: true }] }

describe('catalog entries an Order counts', () => {
    it('leaves out an inactive entry, even one valid today', () => {
        const inactive = contextWith({ kind: 'model', modelId: 'c9300', active: false, validFrom: '2026-01-01', validTo: '2027-01-01' })
        expect(assessOrder(switchLine, inactive)).toEqual({
            verdict: 'off_catalog',
            approvers: ['customer_admin'],
            findings: ['Model c9300 is not in the customer catalog'],
        })
    })

    it('leaves out an entry that becomes valid after today', () => {
        const future = contextWith({ kind: 'model', modelId: 'c9300', active: true, validFrom: '2026-11-07' })
        expect(assessOrder(switchLine, future).verdict).toBe('off_catalog')
    })

    it('counts an entry from the day it becomes valid and up to the day it ends', () => {
        expect(assessOrder(switchLine, contextWith({ kind: 'model', modelId: 'c9300', active: true, validFrom: today })).verdict).toBe('within_agreement')
        expect(assessOrder(switchLine, contextWith({ kind: 'model', modelId: 'c9300', active: true, validTo: today })).verdict).toBe('within_agreement')
    })

    it('counts an active entry without validity dates', () => {
        expect(assessOrder(switchLine, contextWith({ kind: 'model', modelId: 'c9300', active: true })).verdict).toBe('within_agreement')
    })

    it('applies the same window to a Site template entry', () => {
        const inactive = contextWith({ kind: 'site_template', siteTemplateId: 'small-branch', active: false })
        const future = contextWith({ kind: 'site_template', siteTemplateId: 'small-branch', active: true, validFrom: '2027-01-01' })
        const current = contextWith({ kind: 'site_template', siteTemplateId: 'small-branch', active: true, validFrom: '2026-01-01' })
        expect(assessOrder(templateOrder, inactive).findings).toEqual(['Site template small-branch is not in the customer catalog'])
        expect(assessOrder(templateOrder, future).findings).toEqual(['Site template small-branch is not in the customer catalog'])
        expect(assessOrder(templateOrder, current)).toEqual({ verdict: 'within_agreement', approvers: [], findings: [] })
    })

    it('finds a current entry for the Model beside an inactive or future one', () => {
        const mixed = contextWith(
            { kind: 'model', modelId: 'c9300', active: false },
            { kind: 'model', modelId: 'c9300', active: true, validFrom: '2027-01-01' },
            { kind: 'model', modelId: 'c9300', active: true, validFrom: '2026-01-01', validTo: '2026-12-31' },
        )
        expect(assessOrder(switchLine, mixed).verdict).toBe('within_agreement')
    })

    it('needs no current entry for a like-for-like replacement', () => {
        const inactive = contextWith({ kind: 'model', modelId: 'c9300', active: false })
        const replacement = { lines: [{ modelId: 'c9300', deviceClass: 'switch', quantity: 1, replacesAsset: true }] }
        expect(assessOrder(replacement, inactive).verdict).toBe('within_agreement')
    })
})
