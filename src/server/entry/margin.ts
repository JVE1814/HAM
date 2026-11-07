// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideAggregate, GlideRecord, gs } from '@servicenow/glide'
import { monthBounds, overlapsMonth, type MonthBounds } from '../domain/billing'
import type { LegalOwner } from '../domain/lifecycle'
import { cents, CostLedger, marginRows, serviceIntervalCosts, type Amount, type AssetCostFacts, type CostEntry, type LeaseTerms } from '../domain/margin'
import { runEventTableJob } from '../platform/chunked'
import { EVENT, fire } from '../platform/events'
import { intProperty, PROPERTY } from '../platform/properties'
import { count, findById, num, str } from '../platform/records'
import { memoized } from '../domain/memo'

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
    if (!(bounds.days > 0)) return void gs.error(`[x_daas_ham] Margin not computed: billing period ${periodId} has a malformed month '${str(period, 'period')}'`)
    const amortisationMonths = intProperty(PROPERTY.amortisationMonths, 60)
    const ledger = new CostLedger()
    const leases = memoized(leaseTermsOf)
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
        }),
        prepare: withAssets,
        handle: (interval) => {
            const asset = interval.asset
            const costs = serviceIntervalCosts(interval, { ...asset, lease: (asset.leaseId ? leases(asset.leaseId) : null) }, bounds, amortisationMonths)
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

/** A Service interval as stored, with its Asset's sys_id. */
interface IntervalRow {
    customerId: string
    siteId: string
    start: string
    end?: string
    assetId: string
}

/** An Asset's cost fields as stored, with its Lease schedule's sys_id. */
type AssetFields = Omit<AssetCostFacts, 'lease'> & { leaseId: string }

/** A deleted Asset reads as a dot-walk through a broken reference did: empty strings and zeros. */
const NO_ASSET: AssetFields = { legalOwner: '', purchaseCost: 0, purchaseDate: '', inServiceDate: '', supportAnnual: 0, leaseId: '' }

/** The batch's intervals with their Assets' cost fields, read with one query. */
function withAssets(intervals: readonly IntervalRow[]): Array<IntervalRow & { asset: AssetFields }> {
    const ids = [...new Set(intervals.map((interval) => interval.assetId).filter(Boolean))]
    const found = new Map<string, AssetFields>()
    if (ids.length > 0) {
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
    }
    return intervals.map((interval) => ({ ...interval, asset: found.get(interval.assetId) ?? NO_ASSET }))
}

/** A Lease schedule's terms for Margin; null when it is not found. */
function leaseTermsOf(leaseId: string): LeaseTerms | null {
    const lease = findById('x_daas_ham_lease_schedule', leaseId)
    return lease && {
        starts: str(lease, 'starts'),
        ends: str(lease, 'ends'),
        monthlyPayment: num(lease, 'monthly_payment'),
        // While a buyout transfer runs, keep splitting over the Assets covered when it was decided.
        coveredAssets: Math.max(count('alm_hardware', `x_daas_ham_lease=${leaseId}`), num(lease, 'buyout_assets')),
    }
}

function costFactKey(customerId: string, siteId: string, type: string): string {
    return `${customerId}|${siteId}|${type}`
}

/** Add amounts to the period's Cost facts (one per Customer, Site and type), reading the period's facts once. */
function writeCostFacts(periodId: string, entries: readonly CostEntry[]): void {
    if (entries.length === 0) return
    const pending = new Map<string, CostEntry>()
    for (const entry of entries) {
        const key = costFactKey(entry.customerId, entry.siteId, entry.type)
        const amount = (pending.get(key)?.amount ?? 0) + entry.amount
        pending.set(key, { ...entry, amount })
    }
    // Only the facts of the customers being written are read, not the whole period's.
    const customers = [...new Set(entries.map((e) => e.customerId))]
    const fact = new GlideRecord('x_daas_ham_cost_fact')
    fact.addEncodedQuery(`billing_period=${periodId}^customerIN${customers.join(',')}`)
    fact.query()
    while (fact.next()) {
        const key = costFactKey(str(fact, 'customer'), str(fact, 'site'), str(fact, 'cost_type'))
        const entry = pending.get(key)
        if (!entry) continue
        fact.setValue('amount', cents(num(fact, 'amount') + entry.amount))
        fact.update()
        pending.delete(key)
    }
    for (const entry of pending.values()) {
        const added = new GlideRecord('x_daas_ham_cost_fact')
        added.initialize()
        added.setValue('billing_period', periodId)
        added.setValue('customer', entry.customerId)
        added.setValue('site', entry.siteId)
        added.setValue('cost_type', entry.type)
        added.setValue('amount', cents(entry.amount))
        added.insert()
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
