// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideAggregate, GlideRecord, gs } from '@servicenow/glide'
import { monthBounds, overlapsMonth, type MonthBounds } from '../domain/billing'
import type { LegalOwner } from '../domain/lifecycle'
import { cents, CostLedger, marginRows, serviceIntervalCosts, type Amount, type AssetCostFacts, type CostType, type LeaseTerms } from '../domain/margin'
import { runEventTableJob } from '../platform/chunked'
import { EVENT, fire } from '../platform/events'
import { intProperty, PROPERTY } from '../platform/properties'
import { count, findById, num, str } from '../platform/records'

/** Cost facts and Margin per Customer and Site, computed when a Billing period closes (P3.28). */

/** UI action "Recompute margin" on a closed period (and fired by Close period). */
export function uiRecomputeMargin(current: GlideRecord): void {
    fire(EVENT.marginCompute, current, current.getUniqueValue())
    gs.addInfoMessage(`Recomputing margin for ${str(current, 'period')}`)
}

/**
 * Script action on x_daas_ham.margin.compute (parm1 = period): Asset costs over the month's service
 * intervals, then labour and margin. A fresh trigger supersedes a pass still in progress.
 */
export function computeMargin(event: GlideRecord, current: GlideRecord): void {
    const periodId = str(event, 'parm1')
    const period = findById('x_daas_ham_billing_period', periodId)
    if (!period) return
    const bounds = monthBounds(str(period, 'period'))
    const amortisationMonths = intProperty(PROPERTY.amortisationMonths, 60)
    const ledger = new CostLedger()
    const leases = new Map<string, LeaseTerms | null>()
    const result = runEventTableJob({
        eventName: EVENT.marginCompute,
        record: current,
        parm1: periodId,
        cursor: str(event, 'parm2'),
        supersede: { job: `margin_${periodId}`, onStart: () => clearPeriod(periodId) },
        table: 'x_daas_ham_service_interval',
        query: overlapsMonth(bounds),
        read: (interval) => ({
            customerId: str(interval, 'customer'),
            siteId: str(interval, 'site'),
            start: str(interval, 'start_date'),
            end: str(interval, 'end_date') || undefined,
            assetId: str(interval, 'asset'),
            asset: NO_ASSET,
        }),
        prefetch: loadAssets,
        handle: (interval) => {
            const asset = interval.asset
            const costs = serviceIntervalCosts(interval, { ...asset, lease: leaseOf(asset.leaseId, leases) }, bounds, amortisationMonths)
            for (const cost of costs) ledger.add(interval.customerId, interval.siteId, cost.type, cost.amount)
        },
        flush: () => writeCostFacts(periodId, ledger.drain()),
    })
    if (result.failed > 0) gs.error(`[x_daas_ham] Margin of ${str(period, 'period')}: ${result.failed} service interval(s) failed: ${result.lastError}`)
    if (!result.done) return
    addFieldLabour(periodId, bounds)
    writeMargin(periodId)
}

function clearPeriod(periodId: string): void {
    for (const table of ['x_daas_ham_cost_fact', 'x_daas_ham_margin']) {
        const gr = new GlideRecord(table)
        gr.addQuery('billing_period', periodId)
        gr.deleteMultiple()
    }
}

/** An Asset's cost fields as stored, with its Lease schedule's sys_id. */
type AssetFields = Omit<AssetCostFacts, 'lease'> & { leaseId: string }

/** A deleted Asset reads as a dot-walk through a broken reference did: empty strings and zeros. */
const NO_ASSET: AssetFields = { legalOwner: '', purchaseCost: 0, purchaseDate: '', inServiceDate: '', supportAnnual: 0, leaseId: '' }

/** Give each interval of the batch its Asset's cost fields, read with one query (missing Assets keep NO_ASSET). */
function loadAssets(intervals: ReadonlyArray<{ assetId: string; asset: AssetFields }>): void {
    const ids = [...new Set(intervals.map((interval) => interval.assetId).filter(Boolean))]
    if (ids.length === 0) return
    const found = new Map<string, AssetFields>()
    const asset = new GlideRecord('alm_hardware')
    asset.addEncodedQuery(`sys_idIN${ids.join(',')}`)
    asset.query()
    while (asset.next()) {
        found.set(asset.getUniqueValue(), {
            legalOwner: str(asset, 'x_daas_ham_legal_owner') as LegalOwner,
            purchaseCost: num(asset, 'cost'),
            purchaseDate: str(asset, 'purchase_date'),
            inServiceDate: str(asset, 'x_daas_ham_in_service_date'),
            supportAnnual: num(asset, 'x_daas_ham_support_cost'),
            leaseId: str(asset, 'x_daas_ham_lease'),
        })
    }
    for (const interval of intervals) interval.asset = found.get(interval.assetId) ?? NO_ASSET
}

/** The Lease schedule's terms, read once per schedule; null without one or when it is not found. */
function leaseOf(leaseId: string, cache: Map<string, LeaseTerms | null>): LeaseTerms | null {
    if (!leaseId) return null
    const cached = cache.get(leaseId)
    if (cached !== undefined) return cached
    const lease = findById('x_daas_ham_lease_schedule', leaseId)
    const terms = lease && {
        starts: str(lease, 'starts'),
        ends: str(lease, 'ends'),
        monthlyPayment: num(lease, 'monthly_payment'),
        // While a buyout transfer runs, keep splitting over the Assets covered when it was decided.
        coveredAssets: Math.max(count('alm_hardware', `x_daas_ham_lease=${leaseId}`), num(lease, 'buyout_assets')),
    }
    cache.set(leaseId, terms)
    return terms
}

/** Add amounts to the period's Cost facts (one per Customer, Site and type). */
function writeCostFacts(periodId: string, entries: ReadonlyArray<{ customerId: string; siteId: string; type: CostType; amount: number }>): void {
    for (const entry of entries) {
        const fact = new GlideRecord('x_daas_ham_cost_fact')
        fact.addQuery('billing_period', periodId)
        fact.addQuery('customer', entry.customerId)
        fact.addQuery('site', entry.siteId)
        fact.addQuery('cost_type', entry.type)
        fact.setLimit(1)
        fact.query()
        if (fact.next()) {
            fact.setValue('amount', cents(num(fact, 'amount') + entry.amount))
            fact.update()
            continue
        }
        fact.initialize()
        fact.setValue('billing_period', periodId)
        fact.setValue('customer', entry.customerId)
        fact.setValue('site', entry.siteId)
        fact.setValue('cost_type', entry.type)
        fact.setValue('amount', cents(entry.amount))
        fact.insert()
    }
}

/** Field work orders closed in the month: their labour cost, or the standard visit cost. */
function addFieldLabour(periodId: string, bounds: MonthBounds): void {
    const visitCost = intProperty(PROPERTY.visitCost, 250)
    const ledger = new CostLedger()
    const workOrder = new GlideRecord('wm_order')
    workOrder.addEncodedQuery(`x_daas_ham_purposeISNOTEMPTY^closed_at>=${bounds.first} 00:00:00^closed_at<=${bounds.last} 23:59:59`)
    workOrder.query()
    while (workOrder.next()) {
        ledger.add(str(workOrder, 'company'), str(workOrder, 'location'), 'field_labour', num(workOrder, 'x_daas_ham_labour_cost') || visitCost)
    }
    writeCostFacts(periodId, ledger.drain())
}

/** The period's amounts in a table, summed per Customer and Site. */
function sumsBy(table: string, periodId: string): Amount[] {
    const ga = new GlideAggregate(table)
    ga.addEncodedQuery(`billing_period=${periodId}`)
    ga.addAggregate('SUM', 'amount')
    ga.groupBy('customer')
    ga.groupBy('site')
    ga.query()
    const sums: Amount[] = []
    while (ga.next()) {
        sums.push({
            customerId: String(ga.getValue('customer') ?? ''),
            siteId: String(ga.getValue('site') ?? ''),
            amount: Number(ga.getAggregate('SUM', 'amount')) || 0,
        })
    }
    return sums
}

function writeMargin(periodId: string): void {
    for (const row of marginRows(sumsBy('x_daas_ham_billing_line', periodId), sumsBy('x_daas_ham_cost_fact', periodId))) {
        const margin = new GlideRecord('x_daas_ham_margin')
        margin.initialize()
        margin.setValue('billing_period', periodId)
        margin.setValue('customer', row.customerId)
        margin.setValue('site', row.siteId)
        margin.setValue('revenue', row.revenue)
        margin.setValue('cost', row.cost)
        margin.setValue('margin', row.margin)
        margin.setValue('margin_pct', row.marginPct ?? '')
        margin.insert()
    }
}
