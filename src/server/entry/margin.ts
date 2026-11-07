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
import { count, deleteWhere, findById, num, recordsById, str } from '../platform/records'

/** Cost facts and Margin per Customer and Site, computed when a Billing period closes (P3.28). */

/** UI action "Recompute margin" on a closed period (and fired by Close period). */
export function uiRecomputeMargin(current: GlideRecord): void {
    fire(EVENT.marginCompute, current, current.getUniqueValue())
    gs.addInfoMessage(`Recomputing margin for ${str(current, 'period')}`)
}

/**
 * Script action on x_daas_ham.margin.compute (parm1 = period): Asset costs over the month's service
 * intervals, then labour and margin. A fresh trigger supersedes a pass still in progress (ADR 0013).
 */
export function computeMargin(event: GlideRecord, current: GlideRecord): void {
    const periodId = str(event, 'parm1')
    const period = findById('x_daas_ham_billing_period', periodId)
    if (!period) return
    try {
        computeMarginChunk(period, str(event, 'parm2'), current)
    } catch (error) {
        // A chunk that throws queues no next one: the pass stops, and the period must not read as complete.
        const message = error instanceof Error ? error.message : String(error)
        gs.error(`[x_daas_ham] Margin of ${str(period, 'period')} stopped: ${message}`)
        const fresh = findById('x_daas_ham_billing_period', periodId)
        if (fresh) saveMarginStatus(fresh, num(fresh, 'margin_failed'), `stopped: ${message}`)
    }
}

/** One chunk of a margin pass over the period's Service intervals after `cursor`; the pass's completion adds field labour and writes Margin. */
function computeMarginChunk(period: GlideRecord, cursor: string, current: GlideRecord): void {
    const periodId = period.getUniqueValue()
    const bounds = monthBounds(str(period, 'period'))
    const amortisationMonths = intProperty(PROPERTY.amortisationMonths, 60)
    const ledger = new CostLedger()
    const leases = memoized(leaseTermsOf)
    runEventTableJob({
        eventName: EVENT.marginCompute,
        record: current,
        parm1: periodId,
        cursor,
        supersede: {
            job: `margin_${periodId}`,
            onStart: () => {
                clearPeriod(periodId)
                saveMarginStatus(period, 0, '')
            },
            complete: () => {
                addFieldLabour(periodId, bounds)
                writeMargin(periodId)
            },
        },
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
        flush: (failures) => {
            writeCostFacts(periodId, ledger.drain())
            // Failed Service intervals are left out of Margin, so the period counts them to show it is incomplete.
            if (failures.failed > 0) addMarginFailures(periodId, failures.failed, failures.lastError)
        },
    })
}

/** Count Service intervals a chunk of the margin pass failed to cost on its Billing period, with the last error. */
function addMarginFailures(periodId: string, failed: number, lastError: string): void {
    const period = findById('x_daas_ham_billing_period', periodId)
    if (!period) return
    gs.error(`[x_daas_ham] Margin of ${str(period, 'period')}: ${failed} service interval(s) failed: ${lastError}`)
    saveMarginStatus(period, num(period, 'margin_failed') + failed, lastError)
}

/**
 * Save the margin pass's failure count and last error on its Billing period (0 and '' clear them). The
 * period is closed and locked; these fields are about Margin, not the bill, so the lock's rule is not run.
 */
function saveMarginStatus(period: GlideRecord, failed: number, error: string): void {
    period.setValue('margin_failed', failed)
    period.setValue('margin_error', error.slice(0, 255))
    period.setWorkflow(false)
    period.update()
}

/** Empty the period's Cost facts and Margin as a pass starts. */
function clearPeriod(periodId: string): void {
    for (const table of ['x_daas_ham_cost_fact', 'x_daas_ham_margin']) deleteWhere(table, `billing_period=${periodId}`)
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
 * Add a batch's totals by costFactKey (as CostLedger.drain hands them over; this uses them up) to
 * the period's Cost facts, reading the ones they add to with one query.
 */
function writeCostFacts(periodId: string, pending: Map<string, CostEntry>): void {
    if (pending.size === 0) return
    const entries = [...pending.values()]
    const customers = [...new Set(entries.map((entry) => entry.customerId))]
    const types = [...new Set(entries.map((entry) => entry.type))]
    const fact = new GlideRecord('x_daas_ham_cost_fact')
    fact.addEncodedQuery(`billing_period=${periodId}^customerIN${customers.join(',')}^cost_typeIN${types.join(',')}`)
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

/** Field work orders closed in the month, as Cost facts: their labour cost, or the standard visit cost. */
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

/** The amounts of a table's records matching an encoded query, summed per Customer and Site. */
function sumsBy(table: string, encodedQuery: string): Amount[] {
    const ga = new GlideAggregate(table)
    ga.addEncodedQuery(encodedQuery)
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

/** Replace the period's Margin rows with its revenue against its Cost facts. */
function writeMargin(periodId: string): void {
    deleteWhere('x_daas_ham_margin', `billing_period=${periodId}`)
    const revenue = sumsBy('x_daas_ham_billing_line', `billing_period=${periodId}`)
    const cost = sumsBy('x_daas_ham_cost_fact', `billing_period=${periodId}`)
    for (const row of marginRows(revenue, cost)) {
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
