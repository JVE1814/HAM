// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideAggregate, GlideRecord, gs } from '@servicenow/glide'
import { activeDays, monthBounds, type MonthBounds } from '../domain/billing'
import type { LegalOwner } from '../domain/lifecycle'
import { CostLedger, intervalCosts, leaseRunsIn, leaseShare, marginKey, marginRows, type CostType } from '../domain/margin'
import { isCurrentRun, runEventTableJob, startRun } from '../platform/chunked'
import { EVENT, fire } from '../platform/events'
import { intProperty, PROPERTY } from '../platform/properties'
import { findById, num, str } from '../platform/records'

/** Cost facts and Margin per Customer and Site, computed when a Billing period closes (P3.28). */

/** UI action "Recompute margin" on a closed period (and fired by Close period). */
export function uiRecomputeMargin(current: GlideRecord): void {
    fire(EVENT.marginCompute, current, current.getUniqueValue())
    gs.addInfoMessage(`Recomputing margin for ${str(current, 'period')}`)
}

/**
 * Script action on x_daas_ham.margin.compute: Asset costs over the month's service intervals, then
 * labour and margin. parm1 is the period, plus `|token` on continuation events; a fresh trigger
 * starts a new run that supersedes one still in progress.
 */
export function computeMargin(event: GlideRecord, current: GlideRecord): void {
    const [periodId, carriedToken] = str(event, 'parm1').split('|')
    const period = findById('x_daas_ham_billing_period', periodId)
    if (!period) return
    const job = `margin_${periodId}`
    let token = carriedToken ?? ''
    if (!token) {
        token = startRun(job)
        clearPeriod(periodId)
    } else if (!isCurrentRun(job, token)) {
        return
    }
    const bounds = monthBounds(str(period, 'period'))
    const amortisationMonths = intProperty(PROPERTY.amortisationMonths, 60)
    const ledger = new CostLedger()
    const leaseShares = new Map<string, number>()
    const result = runEventTableJob({
        eventName: EVENT.marginCompute,
        record: current,
        parm1: `${periodId}|${token}`,
        cursor: str(event, 'parm2'),
        table: 'x_daas_ham_service_interval',
        query: `start_date<=${bounds.last}^end_dateISEMPTY^ORend_date>=${bounds.first}`,
        read: (interval) => ({
            customerId: str(interval, 'customer'),
            siteId: str(interval, 'site'),
            start: str(interval, 'start_date'),
            end: str(interval, 'end_date') || undefined,
            legalOwner: (str(interval, 'asset.x_daas_ham_legal_owner') || 'provider') as LegalOwner,
            purchaseCost: num(interval, 'asset.cost'),
            purchasedOn: str(interval, 'asset.purchase_date') || str(interval, 'asset.x_daas_ham_in_service_date').slice(0, 10) || undefined,
            leaseId: str(interval, 'asset.x_daas_ham_lease'),
            supportAnnual: num(interval, 'asset.x_daas_ham_support_cost'),
        }),
        handle: (interval) => {
            const costs = intervalCosts({
                days: activeDays(bounds, interval.start, interval.end),
                monthFirst: bounds.first,
                daysInMonth: bounds.days,
                legalOwner: interval.legalOwner,
                purchaseCost: interval.purchaseCost,
                amortisationMonths,
                purchasedOn: interval.purchasedOn,
                leaseMonthly: interval.leaseId ? shareOf(interval.leaseId, bounds, leaseShares) : 0,
                supportAnnual: interval.supportAnnual,
            })
            for (const cost of costs) ledger.add(interval.customerId, interval.siteId, cost.type, cost.amount)
        },
        flush: () => writeCostFacts(period.getUniqueValue(), ledger.drain()),
    })
    if (!result.done || !isCurrentRun(job, token)) return
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

/** The Asset's share of its lease's payment for the month (0 outside the lease term). */
function shareOf(leaseId: string, bounds: MonthBounds, cache: Map<string, number>): number {
    const cached = cache.get(leaseId)
    if (cached !== undefined) return cached
    const lease = findById('x_daas_ham_lease_schedule', leaseId)
    if (!lease || !leaseRunsIn(str(lease, 'starts').slice(0, 10), str(lease, 'ends').slice(0, 10), bounds.first, bounds.last)) {
        cache.set(leaseId, 0)
        return 0
    }
    const covered = new GlideAggregate('alm_hardware')
    covered.addEncodedQuery(`x_daas_ham_lease=${leaseId}`)
    covered.addAggregate('COUNT', '')
    covered.query()
    const share = leaseShare(num(lease, 'monthly_payment'), covered.next() ? Number(covered.getAggregate('COUNT', '')) : 0)
    cache.set(leaseId, share)
    return share
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
            fact.setValue('amount', Math.round((num(fact, 'amount') + entry.amount) * 100) / 100)
            fact.update()
            continue
        }
        fact.initialize()
        fact.setValue('billing_period', periodId)
        fact.setValue('customer', entry.customerId)
        fact.setValue('site', entry.siteId)
        fact.setValue('cost_type', entry.type)
        fact.setValue('amount', Math.round(entry.amount * 100) / 100)
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

function sumsBy(table: string, periodId: string): Map<string, number> {
    const ga = new GlideAggregate(table)
    ga.addEncodedQuery(`billing_period=${periodId}`)
    ga.addAggregate('SUM', 'amount')
    ga.groupBy('customer')
    ga.groupBy('site')
    ga.query()
    const sums = new Map<string, number>()
    while (ga.next()) {
        sums.set(marginKey(String(ga.getValue('customer') ?? ''), String(ga.getValue('site') ?? '')), Number(ga.getAggregate('SUM', 'amount')) || 0)
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
