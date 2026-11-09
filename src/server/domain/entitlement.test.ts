import { describe, expect, it } from 'vitest'
import {
    assessOrder,
    deployedUsageQuery,
    inFlightLinesQuery,
    OPEN_LINE_STAGES,
    ownershipFindings,
    raiserRefusal,
    siteTemplateOffered,
    type EntitlementContext,
    type Orderer,
    type OrderParties,
} from './entitlement'
import { lineStageFor } from './fulfilment'
import { DEPLOYED_STAGES } from './lifecycle'

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

describe('replacement lines', () => {
    it('are within the agreement even when the model is no longer catalogued or the class is at its cap', () => {
        const result = assessOrder(
            { lines: [{ modelId: 'old-switch', deviceClass: 'switch', quantity: 1, replacesAsset: true }, { modelId: 'c9300', deviceClass: 'switch', quantity: 2, replacesAsset: true }] },
            { ...context, usage: [{ deviceClass: 'switch', modelId: 'c9300', count: 10 }] },
        )
        expect(result).toEqual({ verdict: 'within_agreement', approvers: [], findings: [] })
    })
})

describe('ownershipFindings', () => {
    const order: OrderParties = {
        customerId: 'acme',
        agreement: { id: 'acme-agreement', customerId: 'acme' },
        site: { id: 'acme-hq', customerId: 'acme', isSite: true },
        siteTemplate: { id: 'acme-branch', customerId: 'acme' },
    }
    const staff: Orderer = { mayRaise: true, scope: 'everything', customerId: 'provider' }
    const acmeAdmin: Orderer = { mayRaise: true, scope: 'own_customer', customerId: 'acme' }

    it("accepts an order naming the customer's own agreement, site and site template", () => {
        expect(ownershipFindings(order, staff)).toEqual([])
        expect(ownershipFindings(order, acmeAdmin)).toEqual([])
        expect(ownershipFindings({ ...order, siteTemplate: undefined }, acmeAdmin)).toEqual([])
    })

    it('accepts a site template offered to every customer', () => {
        expect(ownershipFindings({ ...order, siteTemplate: { id: 'small-branch', customerId: '' } }, staff)).toEqual([])
    })

    it("refuses another customer's agreement, site or site template, even from provider staff", () => {
        const globex: OrderParties = {
            customerId: 'acme',
            agreement: { id: 'globex-agreement', customerId: 'globex' },
            site: { id: 'globex-dc', customerId: 'globex', isSite: true },
            siteTemplate: { id: 'globex-campus', customerId: 'globex' },
        }
        expect(ownershipFindings(globex, staff)).toEqual([
            "The agreement is not one of the customer's agreements",
            "The site is not one of the customer's sites",
            'The site template is not offered to the customer',
        ])
    })

    it('refuses records it cannot read, and a location that is not a site', () => {
        const unread: OrderParties = {
            customerId: 'acme',
            agreement: { id: 'hidden', customerId: null },
            site: { id: 'acme-mdf', customerId: 'acme', isSite: false },
            siteTemplate: { id: 'gone', customerId: null },
        }
        expect(ownershipFindings(unread, staff)).toEqual([
            "The agreement is not one of the customer's agreements",
            "The site is not one of the customer's sites",
            'The site template is not offered to the customer',
        ])
    })

    it('asks for the customer, agreement and site when the order names none', () => {
        expect(ownershipFindings({ customerId: '' }, staff)).toEqual(['Choose the customer'])
        expect(ownershipFindings({ customerId: 'acme' }, staff)).toEqual(["Choose one of the customer's agreements", "Choose one of the customer's sites"])
    })

    it('lets a customer admin order only for their own customer', () => {
        const globexOrder: OrderParties = {
            customerId: 'globex',
            agreement: { id: 'globex-agreement', customerId: 'globex' },
            site: { id: 'globex-dc', customerId: 'globex', isSite: true },
        }
        expect(ownershipFindings(globexOrder, acmeAdmin)).toEqual(['You can only order for your own customer'])
        expect(ownershipFindings({ customerId: '' }, acmeAdmin)).toEqual(['You can only order for your own customer'])
        expect(ownershipFindings(order, { ...acmeAdmin, customerId: '' })).toEqual(['You can only order for your own customer'])
        expect(ownershipFindings(globexOrder, staff)).toEqual([])
    })

    it('lets the service desk, who see no slice of their own, order for any customer', () => {
        expect(ownershipFindings(order, { mayRaise: true, scope: 'unscoped', customerId: '' })).toEqual([])
    })

    it('refuses anyone who is not an order raiser, however much they see', () => {
        for (const scope of ['everything', 'assigned_stockrooms', 'own_customer', 'unscoped'] as const) {
            expect(ownershipFindings(order, { mayRaise: false, scope, customerId: 'acme' })).toEqual(['You may not raise orders'])
        }
    })

    it('refuses site contacts, even with a role that raises orders', () => {
        expect(ownershipFindings(order, { mayRaise: true, scope: 'own_sites', customerId: 'acme' })).toEqual(['You may not raise orders'])
    })
})

describe('raiserRefusal', () => {
    it('is about who raises the order for which customer, not the records it names', () => {
        expect(raiserRefusal('acme', { mayRaise: true, scope: 'own_customer', customerId: 'acme' })).toBeNull()
        expect(raiserRefusal('globex', { mayRaise: true, scope: 'everything', customerId: 'provider' })).toBeNull()
        expect(raiserRefusal('globex', { mayRaise: true, scope: 'own_customer', customerId: 'acme' })).toBe('You can only order for your own customer')
        expect(raiserRefusal('acme', { mayRaise: false, scope: 'everything', customerId: 'provider' })).toBe('You may not raise orders')
    })
})

describe('siteTemplateOffered', () => {
    it("holds for no site template, one offered to every customer and the customer's own, not for another's or one it cannot read", () => {
        expect(siteTemplateOffered({ customerId: 'acme' })).toBe(true)
        expect(siteTemplateOffered({ customerId: 'acme', siteTemplate: { id: 'small-branch', customerId: '' } })).toBe(true)
        expect(siteTemplateOffered({ customerId: 'acme', siteTemplate: { id: 'acme-branch', customerId: 'acme' } })).toBe(true)
        expect(siteTemplateOffered({ customerId: 'acme', siteTemplate: { id: 'globex-campus', customerId: 'globex' } })).toBe(false)
        expect(siteTemplateOffered({ customerId: 'acme', siteTemplate: { id: 'gone', customerId: null } })).toBe(false)
    })
})

describe('usage queries', () => {
    const open = 'new,awaiting_stock,sourced,staging,ready_to_ship'

    it("counts the Agreement's deployed fleet assets except those on an open Order line, in every stage clause", () => {
        const clauses = deployedUsageQuery('a1').split('^NQ')
        const base = `^x_daas_ham_agreement=a1^x_daas_ham_order_lineISEMPTY^ORx_daas_ham_order_line.line_stageNOT IN${open}^x_daas_ham_fleet=true`
        expect(clauses).toHaveLength(DEPLOYED_STAGES.length)
        for (const clause of clauses) expect(clause.endsWith(base)).toBe(true)
    })

    it('counts in flight the open lines of the Agreement on other live Orders', () => {
        expect(inFlightLinesQuery('a1', 'o1')).toBe(`order.agreement=a1^order!=o1^order.stageNOT INdraft,rejected,cancelled^line_stageIN${open}`)
    })

    it('keeps a partly shipped line open, so its shipped units count once, through its quantity', () => {
        expect(OPEN_LINE_STAGES).toContain(lineStageFor({ current: 'ready_to_ship', quantity: 2, assetStages: ['shipped', 'staged'] }))
        expect(OPEN_LINE_STAGES).not.toContain(lineStageFor({ current: 'ready_to_ship', quantity: 2, assetStages: ['shipped', 'shipped'] }))
    })
})
