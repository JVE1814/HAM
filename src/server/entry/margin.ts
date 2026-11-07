// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideAggregate, GlideRecord, gs } from '@servicenow/glide'
import { monthBounds, overlapsMonth, type MonthBounds } from '../domain/billing'
import type { LegalOwner } from '../domain/lifecycle'
import { cents, CostLedger, costFactKey, marginRows, serviceIntervalCosts, type Amount, type AssetCostFacts, type CostEntry, type LeaseTerms } from '../domain/margin'
import { memoized } from '../domain/memo'
import { runEventTableJob } from '../platform/chunked'
import { EVENT, fire } from '../platform/events'
import { intProperty, PROPERTY } from '../platform/properties'
import { count, findById, num, recordsById, str } from '../platform/records'

/** Cost facts and Margin per Customer and Site, computed when a Billing period closes (P3.28). */

/** UI action "Recompute margin" on a closed period (and fired by Close period). */
export function uiRecomputeMargin(current: GlideRecord): void {
    fire(EVENT.marginCompute, current, current.getUniqueValue())
    gs.addInfoMessage(`Recomputing margin for ${str(current, 'period')}`)
}

/**
 * Script action on x_daas_ham.margin.compute (parm1 = period): Asset costs over the month's service
 * intervals, then labour and margin. A fresh trigger supersedes a pass still in progress: each pass
 * writes Cost facts under its own run, and the pass that completes keeps only its own.
 */
export function computeMargin(event: GlideRecord, current: GlideRecord): void {
    const periodId = str(event, 'parm1')
    const period = findById('x_daas_ham_billing_period', periodId)
    if (!period) return
    const bounds = monthBounds(str(period, 'period'))
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
        flush: (run) => writeCostFacts(periodId, run, ledger.drain()),
    })
    if (result.failed > 0) gs.error(`[x_daas_ham] Margin of ${str(period, 'period')}: ${result.failed} service interval(s) failed: ${result.lastError}`)
    if (!result.done) return
    // Keep only this pass's Cost facts: a superseded pass may have flushed a last batch after this one started.
    deleteWhere('x_daas_ham_cost_fact', `billing_period=${periodId}^run!=${result.run}`)
    addFieldLabour(periodId, result.run, bounds)
    writeMargin(periodId)
}

function clearPeriod(periodId: string): void {
    for (const table of ['x_daas_ham_cost_fact', 'x_daas_ham_margin']) deleteWhere(table, `billing_period=${periodId}`)
}

function deleteWhere(table: string, encodedQuery: string): void {
    const gr = new GlideRecord(table)
    gr.addEncodedQuery(encodedQuery)
    gr.deleteMultiple()
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
    const found = recordsById(
        'alm_hardware',
        intervals.map((interval) => interval.assetId),
        (asset): AssetFields => ({
            legalOwner: str(asset, 'x_daas_ham_legal_owner') as LegalOwner,
            purchaseCost: num(asset, 'cost'),
            purchaseDate: str(asset, 'purchase_date'),
            inServiceDate: str(asset, 'x_daas_ham_in_service_date'),
            supportAnnual: num(asset, 'x_daas_ham_support_cost'),
            leaseId: str(asset, 'x_daas_ham_lease'),
        }),
    )
    return intervals.map((interval) => ({ ...interval, asset: found.get(interval.assetId) ?? NO_ASSET }))
}

/** A Lease schedule's terms for Margin; null when it is not found. */
function leaseTermsOf(leaseId: string): LeaseTerms | null {
    const lease = findById('x_daas_ham_lease_schedule', leaseId)
    return lease && {
        starts: str(lease, 'starts'),
        ends: str(lease, 'ends'),
        monthlyPayment: num(lease, 'monthly_payment'),
        coveredAssets: count('alm_hardware', `x_daas_ham_lease=${leaseId}`),
        buyoutAssets: num(lease, 'buyout_assets'),
    }
}

/**
 * Add a batch's totals (at most one per Customer, Site and type, as CostLedger.drain gives them) to
 * the Cost facts the pass `run` wrote for the period, reading the ones they add to with one query.
 */
function writeCostFacts(periodId: string, run: string, entries: readonly CostEntry[]): void {
    if (entries.length === 0) return
    const pending = new Map(entries.map((entry) => [costFactKey(entry.customerId, entry.siteId, entry.type), entry]))
    const customers = [...new Set(entries.map((entry) => entry.customerId))]
    const types = [...new Set(entries.map((entry) => entry.type))]
    const fact = new GlideRecord('x_daas_ham_cost_fact')
    fact.addEncodedQuery(`billing_period=${periodId}^run=${run}^customerIN${customers.join(',')}^cost_typeIN${types.join(',')}`)
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
        added.setValue('run', run)
        added.setValue('customer', entry.customerId)
        added.setValue('site', entry.siteId)
        added.setValue('cost_type', entry.type)
        added.setValue('amount', cents(entry.amount))
        added.insert()
    }
}

/** Field work orders closed in the month, as Cost facts of the pass `run`: their labour cost, or the standard visit cost. */
function addFieldLabour(periodId: string, run: string, bounds: MonthBounds): void {
    const visitCost = intProperty(PROPERTY.visitCost, 250)
    const ledger = new CostLedger()
    const workOrder = new GlideRecord('wm_order')
    workOrder.addEncodedQuery(`x_daas_ham_purposeISNOTEMPTY^closed_at>=${bounds.first} 00:00:00^closed_at<=${bounds.last} 23:59:59`)
    workOrder.query()
    while (workOrder.next()) {
        ledger.add(str(workOrder, 'company'), str(workOrder, 'location'), 'field_labour', num(workOrder, 'x_daas_ham_labour_cost') || visitCost)
    }
    writeCostFacts(periodId, run, ledger.drain())
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
    deleteWhere('x_daas_ham_margin', `billing_period=${periodId}`)
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
