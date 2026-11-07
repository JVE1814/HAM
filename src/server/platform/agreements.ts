import { GlideAggregate, GlideRecord } from '@servicenow/glide'
import {
    deployedUsageQuery,
    inFlightLinesQuery,
    type CatalogEntryView,
    type ContractedQuantity,
    type EntitlementContext,
    type Usage,
} from '../domain/entitlement'
import { todayIso } from './clock'
import { bool, num, str } from './records'

/** Read models of an Agreement and its Customer catalog, as the entitlement module needs them. */

export function entitlementContext(customerId: string, agreementId: string, excludeOrderId: string): EntitlementContext {
    return {
        catalog: catalogEntries(customerId),
        quantities: contractedQuantities(agreementId),
        usage: [...deployedUsage(agreementId), ...inFlightUsage(agreementId, excludeOrderId)],
        today: todayIso(),
    }
}

function catalogEntries(customerId: string): CatalogEntryView[] {
    const gr = new GlideRecord('x_daas_ham_catalog_entry')
    gr.addQuery('customer', customerId)
    gr.query()
    const entries: CatalogEntryView[] = []
    while (gr.next()) {
        entries.push({
            kind: str(gr, 'entry_type') as CatalogEntryView['kind'],
            modelId: str(gr, 'model') || undefined,
            siteTemplateId: str(gr, 'site_template') || undefined,
            active: bool(gr, 'active'),
            validFrom: str(gr, 'valid_from') || undefined,
            validTo: str(gr, 'valid_to') || undefined,
        })
    }
    return entries
}

function contractedQuantities(agreementId: string): ContractedQuantity[] {
    const gr = new GlideRecord('x_daas_ham_agreement_quantity')
    gr.addQuery('agreement', agreementId)
    gr.query()
    const quantities: ContractedQuantity[] = []
    while (gr.next()) {
        quantities.push({
            deviceClass: str(gr, 'device_class'),
            modelId: str(gr, 'model') || undefined,
            contracted: num(gr, 'contracted_quantity'),
        })
    }
    return quantities
}

/** The Agreement's Assets at or on their way to a Site, but not those still on an open Order line (counted in flight). */
function deployedUsage(agreementId: string): Usage[] {
    const ga = new GlideAggregate('alm_hardware')
    ga.addEncodedQuery(deployedUsageQuery(agreementId))
    ga.addAggregate('COUNT', '')
    ga.groupBy('model')
    ga.groupBy('model.x_daas_ham_device_class')
    ga.query()
    const usage: Usage[] = []
    while (ga.next()) {
        usage.push({
            modelId: String(ga.getValue('model') ?? ''),
            deviceClass: String(ga.getValue('model.x_daas_ham_device_class') ?? ''),
            count: Number(ga.getAggregate('COUNT', '')),
        })
    }
    return usage
}

/** Whole quantities on other open Order lines of the Agreement that have not shipped yet, partly shipped included. */
function inFlightUsage(agreementId: string, excludeOrderId: string): Usage[] {
    const ga = new GlideAggregate('x_daas_ham_order_line')
    ga.addEncodedQuery(inFlightLinesQuery(agreementId, excludeOrderId))
    ga.addAggregate('SUM', 'quantity')
    ga.groupBy('model')
    ga.groupBy('model.x_daas_ham_device_class')
    ga.query()
    const usage: Usage[] = []
    while (ga.next()) {
        usage.push({
            modelId: String(ga.getValue('model') ?? ''),
            deviceClass: String(ga.getValue('model.x_daas_ham_device_class') ?? ''),
            count: Number(ga.getAggregate('SUM', 'quantity')),
        })
    }
    return usage
}
