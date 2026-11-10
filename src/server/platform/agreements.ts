import { GlideAggregate, GlideRecord } from '@servicenow/glide'
import {
    deployedUsageQuery,
    inFlightLinesQuery,
    isCurrent,
    type CatalogEntryView,
    type ContractedQuantity,
    type EntitlementContext,
    type Usage,
} from '../domain/entitlement.ts'
import { todayIso } from './clock.ts'
import { bool, num, str } from './records.ts'

/** Read models of an Agreement and its Customer catalog, as the entitlement module needs them. */

/**
 * The Agreements in force: an Agreement is a contract (it extends ast_contract), and this is the state the platform's
 * Contract Management gives one that is active. What the daily jobs that act for running Agreements select.
 */
export const ACTIVE_AGREEMENTS = 'state=active'

export function entitlementContext(customerId: string, agreementId: string, excludeOrderId: string): EntitlementContext {
    return {
        catalog: catalogEntries(customerId),
        quantities: contractedQuantities(agreementId),
        usage: [...deployedUsage(agreementId), ...inFlightUsage(agreementId, excludeOrderId)],
        today: todayIso(),
    }
}

function catalogEntries(customerId: string): CatalogEntryView[] {
    const entries: CatalogEntryView[] = []
    eachCatalogEntry(customerId, (entry) => entries.push(entry))
    return entries
}

/** Visit each entry of the Customer's catalog, current or not, with its record. */
function eachCatalogEntry(customerId: string, visit: (entry: CatalogEntryView, record: GlideRecord) => void): void {
    const gr = new GlideRecord('x_daas_ham_catalog_entry')
    gr.addQuery('customer', customerId)
    gr.query()
    while (gr.next()) {
        const entry: CatalogEntryView = {
            kind: str(gr, 'entry_type') as CatalogEntryView['kind'],
            modelId: str(gr, 'model') || undefined,
            siteTemplateId: str(gr, 'site_template') || undefined,
            active: bool(gr, 'active'),
            validFrom: str(gr, 'valid_from') || undefined,
            validTo: str(gr, 'valid_to') || undefined,
        }
        visit(entry, gr)
    }
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
    return usageByModel('alm_hardware', deployedUsageQuery(agreementId), 'COUNT', '')
}

/** Whole quantities on other open Order lines of the Agreement that have not shipped yet, partly shipped included. */
function inFlightUsage(agreementId: string, excludeOrderId: string): Usage[] {
    return usageByModel('x_daas_ham_order_line', inFlightLinesQuery(agreementId, excludeOrderId), 'SUM', 'quantity')
}

/** One aggregate of the records `query` matches, for each Model and its Device class. */
function usageByModel(table: string, query: string, aggregate: 'COUNT' | 'SUM', field: string): Usage[] {
    const ga = new GlideAggregate(table)
    ga.addEncodedQuery(query)
    ga.addAggregate(aggregate, field)
    ga.groupBy('model')
    ga.groupBy('model.x_daas_ham_device_class')
    ga.query()
    const usage: Usage[] = []
    while (ga.next()) {
        usage.push({
            modelId: String(ga.getValue('model') ?? ''),
            deviceClass: String(ga.getValue('model.x_daas_ham_device_class') ?? ''),
            count: Number(ga.getAggregate(aggregate, field)),
        })
    }
    return usage
}

/**
 * The Models a Customer's catalog offers now, each with its Device class: its Model entries that are current as the
 * entitlement check reads them (domain/entitlement `isCurrent`: active and inside their validity dates), so a Model
 * picked from here is one an Order for it is not flagged for.
 */
export function catalogModels(customerId: string): Array<{ modelId: string; deviceClass: string }> {
    const today = todayIso()
    const models: Array<{ modelId: string; deviceClass: string }> = []
    eachCatalogEntry(customerId, (entry, record) => {
        if (entry.kind !== 'model' || !isCurrent(entry, today)) return
        models.push({ modelId: entry.modelId ?? '', deviceClass: str(record, 'model.x_daas_ham_device_class') })
    })
    return models
}
