import { describe, expect, it } from 'vitest'
import { assessOrder, type EntitlementContext } from './entitlement'

const context: EntitlementContext = {
    catalog: [
        { kind: 'model', modelId: 'c9300', active: true },
        { kind: 'model', modelId: 'mr46', active: true, validTo: '2026-01-31' },
        { kind: 'site_template', siteTemplateId: 'small-branch', active: true },
    ],
    quantities: [
        { deviceClass: 'switch', contracted: 10 },
        { deviceClass: 'ap', modelId: 'mr46', contracted: 20 },
    ],
    usage: [
        { deviceClass: 'switch', modelId: 'c9300', count: 8 },
        { deviceClass: 'ap', modelId: 'mr46', count: 5 },
    ],
    today: '2026-11-06',
}

describe('assessOrder', () => {
    it('is within the agreement when every model is catalogued and quantities fit', () => {
        const result = assessOrder({ lines: [{ modelId: 'c9300', deviceClass: 'switch', quantity: 2 }] }, context)
        expect(result).toEqual({ verdict: 'within_agreement', approvers: [], findings: [] })
    })

    it('needs the customer admin for a model that is not in the customer catalog', () => {
        const result = assessOrder({ lines: [{ modelId: 'fg60f', deviceClass: 'firewall', quantity: 1 }] }, context)
        expect(result.verdict).toBe('off_catalog')
        expect(result.approvers).toEqual(['customer_admin'])
        expect(result.findings).toEqual(['Model fg60f is not in the customer catalog'])
    })

    it('ignores catalog entries that have expired', () => {
        const result = assessOrder({ lines: [{ modelId: 'mr46', deviceClass: 'ap', quantity: 1 }] }, context)
        expect(result.verdict).toBe('off_catalog')
    })

    it('treats lines from a catalogued site template as catalogued', () => {
        const result = assessOrder(
            { siteTemplateId: 'small-branch', lines: [{ modelId: 'fg60f', deviceClass: 'firewall', quantity: 1, fromSiteTemplate: true }] },
            context,
        )
        expect(result.verdict).toBe('within_agreement')
    })

    it('flags a site template that is not in the customer catalog', () => {
        const result = assessOrder({ siteTemplateId: 'campus', lines: [] }, context)
        expect(result.verdict).toBe('off_catalog')
        expect(result.findings).toEqual(['Site template campus is not in the customer catalog'])
    })

    it('needs the customer admin and the account manager when a contracted quantity would be exceeded', () => {
        const result = assessOrder({ lines: [{ modelId: 'c9300', deviceClass: 'switch', quantity: 3 }] }, context)
        expect(result.verdict).toBe('over_quota')
        expect(result.approvers).toEqual(['customer_admin', 'account_manager'])
        expect(result.findings).toEqual(['switch: 8 in use + 3 requested exceeds 10 contracted'])
    })

    it('applies a model-specific quantity to that model only', () => {
        const fine = assessOrder({ siteTemplateId: 'small-branch', lines: [{ modelId: 'mr46', deviceClass: 'ap', quantity: 15, fromSiteTemplate: true }] }, context)
        expect(fine.verdict).toBe('within_agreement')
        const over = assessOrder({ siteTemplateId: 'small-branch', lines: [{ modelId: 'mr46', deviceClass: 'ap', quantity: 16, fromSiteTemplate: true }] }, context)
        expect(over.verdict).toBe('over_quota')
    })

    it('does not limit device classes the agreement does not cap', () => {
        const result = assessOrder({ siteTemplateId: 'small-branch', lines: [{ modelId: 'fg60f', deviceClass: 'firewall', quantity: 50, fromSiteTemplate: true }] }, context)
        expect(result.verdict).toBe('within_agreement')
    })

    it('reports every finding but takes the strictest verdict', () => {
        const result = assessOrder(
            { lines: [{ modelId: 'fg60f', deviceClass: 'firewall', quantity: 1 }, { modelId: 'c9300', deviceClass: 'switch', quantity: 5 }] },
            context,
        )
        expect(result.verdict).toBe('over_quota')
        expect(result.findings).toHaveLength(2)
    })
})
