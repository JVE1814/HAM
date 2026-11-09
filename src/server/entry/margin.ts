// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideAggregate, GlideRecord, gs } from '@servicenow/glide'
import { monthBounds, overlapsMonth, type MonthBounds } from '../domain/billing.ts'
import { stillCovered } from '../domain/leases.ts'
import type { LegalOwner } from '../domain/lifecycle.ts'
import { cents, CostLedger, costFactKey, marginRows, serviceIntervalCosts, type Amount, type AssetCostFacts, type CostEntry, type LeaseTerms } from '../domain/margin.ts'
import { memoized } from '../domain/memo.ts'
import { runEventTableJob } from '../platform/chunked.ts'
import { EVENT, fire } from '../platform/events.ts'
import { intProperty, PROPERTY } from '../platform/properties.ts'
import { count, deleteWhere, findById, num, recordsById, refusal, str } from '../platform/records.ts'

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
        // The pass stops (the runner records it on the period through `stopped` while the pass is current).
        gs.error(`[x_daas_ham] Margin of ${str(period, 'period')} stopped: ${error instanceof Error ? error.message : String(error)}`)
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
                // The status first: if the period refuses it, the pass stops before its Margin is cleared.
                saveMarginStatus(period, 0, '')
                clearPeriod(periodId)
            },
            complete: () => {
                addFieldLabour(periodId, bounds)
                writeMargin(periodId)
            },
            // A chunk that throws queues no next one: the pass stops, and the period must not read as complete.
            stopped: (error) => {
                const fresh = findById('x_daas_ham_billing_period', periodId)
                if (fresh) saveMarginStatus(fresh, num(fresh, 'margin_failed'), `stopped: ${error}`)
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
 * A refused save throws (see checkSaved): a period whose count is not saved would read as complete.
 */
function saveMarginStatus(period: GlideRecord, failed: number, error: string): void {
    period.setValue('margin_failed', failed)
    period.setValue('margin_error', error.slice(0, 255))
    period.setWorkflow(false)
    checkSaved(period.update(), period, 'Margin status')
}

/** Empty the period's Cost facts and Margin as a pass starts. A row left throws (see clearRows). */
function clearPeriod(periodId: string): void {
    clearRows('x_daas_ham_cost_fact', periodId, 'Cost facts')
    clearRows('x_daas_ham_margin', periodId, 'Margin rows')
}

/**
 * Delete the period's rows of `table`, throwing when any is left (a rule can keep one), so that the pass stops and
 * records why on the period (ADR 0013): the pass would add to a Cost fact left, and write Margin beside a row left.
 */
function clearRows(table: string, periodId: string, what: string): void {
    if (!deleteWhere(table, `billing_period=${periodId}`)) throw new Error(`old ${what} not all removed`)
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
        coveredAssets: count('alm_hardware', stillCovered(`x_daas_ham_lease=${leaseId}`)),
        buyoutAssets: num(lease, 'buyout_assets'),
    }
}

/**
 * Add a batch's totals by costFactKey (as CostLedger.drain hands them over; this uses them up) to
 * the period's Cost facts, reading the ones they add to with one query. A refused save throws (see checkSaved).
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
        checkSaved(fact.update(), fact, `${entry.type} Cost fact`)
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
        checkSaved(added.insert(), added, `${entry.type} Cost fact`)
    }
}

/**
 * Throw when the platform refused a save of the pass, so that the pass stops and records why on the period
 * (ADR 0013) instead of completing with that cost or Margin row left out.
 */
function checkSaved(sysId: string | null, record: GlideRecord, what: string): void {
    if (!sysId) throw new Error(`${what} not saved: ${refusal(record)}`)
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

/** Replace the period's Margin rows with its revenue against its Cost facts. A row left throws (see clearRows). */
function writeMargin(periodId: string): void {
    clearRows('x_daas_ham_margin', periodId, 'Margin rows')
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
        checkSaved(margin.insert(), margin, 'Margin row')
    }
}
