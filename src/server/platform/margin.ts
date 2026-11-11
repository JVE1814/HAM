import { GlideAggregate, GlideRecord } from '@servicenow/glide'
import { chooseCurrency, currencyCode, currencyKey, currencyOrThrow, monthBounds, overlapsMonth, type AgreementCurrency, type MonthBounds } from '../domain/billing.ts'
import { messageOf } from '../domain/errors.ts'
import { stillCovered } from '../domain/leases.ts'
import {
    cents,
    CostLedger,
    costFactKey,
    labourCost,
    marginRows,
    serviceIntervalCosts,
    type Amount,
    type AssetCostFacts,
    type CostEntry,
    type LeaseTerms,
} from '../domain/margin.ts'
import { memoized } from '../domain/memo.ts'
import { SHIPMENT_STATUS, type LegalOwner } from '../domain/vocabulary.ts'
import { agreementCurrencyOf, customerCurrencies, recordMarginOutcome } from './billing.ts'
import { runEventTableJob } from './chunked.ts'
import { queueJob, type JobEvent } from './events.ts'
import { EVENT } from '../domain/events.ts'
import { intProperty } from './properties.ts'
import { PROPERTY } from '../domain/properties.ts'
import { count, deleteWhere, findById, num, recordsById, str, throwRefused } from './records.ts'
import { log } from './log.ts'

/**
 * Cost facts and Margin per Customer, Site and currency, computed when a Billing period closes (plan §13 Margin / TCO). A cost is kept
 * in its Agreement's currency (a shipment's in its carrier's), and Margin sets revenue against cost per currency.
 */

/** Queue a fresh margin pass for a closed period: it supersedes one still in progress (ADR 0013). */
export function queueMarginCompute(period: GlideRecord): void {
    queueJob(EVENT.marginCompute, period)
}

/**
 * One chunk of a margin pass for the period the event names: Asset costs over the month's Service intervals, then
 * labour and margin. A pass that stops is logged (the runner records it on the period while the pass is current).
 */
export function computeMarginChunk(queued: JobEvent): void {
    const period = findById('x_daas_ham_billing_period', queued.subject)
    if (!period) return
    try {
        costServiceIntervals(period, queued)
    } catch (error) {
        log.error(`Margin of ${str(period, 'period')} stopped: ${messageOf(error)}`)
    }
}

/** One chunk of a margin pass over the period's Service intervals after the event's cursor; the pass's completion adds field labour and writes Margin. */
function costServiceIntervals(period: GlideRecord, queued: JobEvent): void {
    const periodId = period.getUniqueValue()
    const bounds = monthBounds(str(period, 'period'))
    const amortisationMonths = intProperty(PROPERTY.amortisationMonths)
    const ledger = new CostLedger()
    const leases = memoized(leaseTermsOf)
    const currencies = memoized(customerCurrencies)
    const lineAgreements = memoized(lineAgreementOf)
    runEventTableJob(queued, {
        pass: {
            job: `margin_${periodId}`,
            underLock: {
                onStart: () => {
                    // The status first: if the period refuses it, the pass stops before its Margin is cleared.
                    recordMarginOutcome(period, 0, '')
                    clearPeriod(periodId)
                },
                complete: () => {
                    const labour = addFieldLabour(periodId, bounds)
                    const shipping = addShippingCosts(periodId, bounds)
                    // Left out of Margin, as failed Service intervals are, and counted on the period with them.
                    const failed = labour.failed + shipping.failed
                    if (failed > 0) addMarginFailures(periodId, failed, shipping.lastError || labour.lastError)
                    writeMargin(periodId)
                },
                // A chunk that throws queues no next one: the pass stops, and the period must not read as complete.
                stopped: (error) => {
                    const fresh = findById('x_daas_ham_billing_period', periodId)
                    if (fresh) recordMarginOutcome(fresh, num(fresh, 'margin_failed'), `stopped: ${error}`)
                },
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
            lineId: str(interval, 'subscription_line'),
        }),
        prepare: withAssets,
        handle: (interval) => {
            const asset = interval.asset
            // Its costs are not known, so it fails (counted on the period) rather than being costed at nothing.
            if (!asset) throw new Error(`its Asset ${interval.assetId || '(none)'} is not found, so its costs are not known`)
            // Its Subscription line's Agreement's currency: without one the interval fails (counted), as an unknown Asset does.
            const currency = currencyOrThrow(chooseCurrency(lineAgreements(interval.lineId), () => currencies(interval.customerId)))
            const costs = serviceIntervalCosts(interval, { ...asset, lease: (asset.leaseId ? leases(asset.leaseId) : null) }, bounds, amortisationMonths)
            for (const cost of costs) ledger.add({ customerId: interval.customerId, siteId: interval.siteId, currency, ...cost })
        },
        flush: (failures) => {
            writeCostFacts(periodId, ledger.drain())
            // Failed Service intervals are left out of Margin, so the period counts them to show it is incomplete.
            if (failures.failed > 0) addMarginFailures(periodId, failures.failed, failures.lastError)
        },
    })
}

/**
 * Count Service intervals a chunk of the margin pass failed to cost on its Billing period, with the last error (and the
 * work orders and shipments its completion failed to cost).
 */
function addMarginFailures(periodId: string, failed: number, lastError: string): void {
    const period = findById('x_daas_ham_billing_period', periodId)
    if (!period) return
    log.error(`Margin of ${str(period, 'period')}: ${failed} record(s) failed to cost: ${lastError}`)
    recordMarginOutcome(period, num(period, 'margin_failed') + failed, lastError)
}

/**
 * As a pass starts, empty the period's Cost facts, which the pass adds to, and its Margin, which would show the last
 * pass's until this one completes. A row left throws (see clearRows).
 */
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

/** A Service interval as stored, with its Asset's and its Subscription line's sys_ids. */
interface IntervalRow {
    customerId: string
    siteId: string
    start: string
    end?: string
    assetId: string
    lineId: string
}

/** The Agreement of a Subscription line, for its currency (a chunk reads each line once); null when the line is gone. */
function lineAgreementOf(lineId: string): AgreementCurrency | null {
    const line = findById('x_daas_ham_subscription_line', lineId)
    return line && agreementCurrencyOf(line, 'agreement')
}

/** An Asset's cost fields as stored, with its Lease schedule's sys_id. */
type AssetFields = Omit<AssetCostFacts, 'lease'> & { leaseId: string }

/**
 * The batch's intervals with their Assets' cost fields, read with one query. An interval whose Asset is not found (it
 * was deleted) has none, and fails when it is handled.
 */
function withAssets(intervals: readonly IntervalRow[]): Array<IntervalRow & { asset: AssetFields | null }> {
    const found = recordsById(
        'alm_hardware',
        intervals.map((interval) => interval.assetId),
        (asset): AssetFields => ({
            legalOwner: str(asset, 'x_daas_ham_legal_owner') as LegalOwner | '',
            purchaseCost: num(asset, 'cost'),
            purchaseDate: str(asset, 'purchase_date'),
            inServiceDate: str(asset, 'x_daas_ham_in_service_date'),
            supportAnnual: num(asset, 'x_daas_ham_support_cost'),
            leaseId: str(asset, 'x_daas_ham_lease'),
        }),
    )
    return intervals.map((interval) => ({ ...interval, asset: found.get(interval.assetId) ?? null }))
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
 * the period's Cost facts, reading the ones they add to with one query. A refused save throws (platform/records
 * `throwRefused`), so that the pass stops and records why on the period (ADR 0013) instead of completing with that cost
 * left out.
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
        const key = costFactKey(str(fact, 'customer'), str(fact, 'site'), str(fact, 'cost_type'), str(fact, 'currency'))
        const entry = pending.get(key)
        if (!entry) continue
        fact.setValue('amount', cents(num(fact, 'amount') + entry.amount))
        if (!fact.update()) throwRefused(fact, `${entry.type} Cost fact not saved`)
        pending.delete(key)
    }
    for (const entry of pending.values()) {
        const added = new GlideRecord('x_daas_ham_cost_fact')
        added.initialize()
        added.setValue('billing_period', periodId)
        added.setValue('customer', entry.customerId)
        added.setValue('site', entry.siteId)
        added.setValue('cost_type', entry.type)
        added.setValue('currency', entry.currency)
        added.setValue('amount', cents(entry.amount))
        if (!added.insert()) throwRefused(added, `${entry.type} Cost fact not saved`)
    }
}

/** How many records a step of the pass's completion failed to cost, and the last one's error. */
interface Failed {
    failed: number
    lastError: string
}

/**
 * Field work orders closed in the month, as Cost facts: their labour cost (an explicit 0 included), else the standard
 * visit cost. Each is kept in the currency of the Agreement its Order or Return order names, else in the one its
 * Customer's Agreements share (a site audit's); one without a currency is left out and counted.
 */
function addFieldLabour(periodId: string, bounds: MonthBounds): Failed {
    const visitCost = intProperty(PROPERTY.visitCost)
    const currencies = memoized(customerCurrencies)
    const ledger = new CostLedger()
    const result: Failed = { failed: 0, lastError: '' }
    const workOrder = new GlideRecord('wm_order')
    workOrder.addEncodedQuery(`x_daas_ham_purposeISNOTEMPTY^closed_at>=${bounds.first} 00:00:00^closed_at<=${bounds.last} 23:59:59`)
    workOrder.query()
    while (workOrder.next()) {
        const customerId = str(workOrder, 'company')
        const currency = chooseCurrency(workOrderAgreement(workOrder), () => currencies(customerId))
        if ('problem' in currency) {
            result.failed++
            result.lastError = `work order ${str(workOrder, 'number')}: no currency: ${currency.problem}`
            continue
        }
        const amount = labourCost(str(workOrder, 'x_daas_ham_labour_cost'), visitCost)
        ledger.add({ customerId, siteId: str(workOrder, 'location'), type: 'field_labour', currency: currency.currency, amount })
    }
    writeCostFacts(periodId, ledger.drain())
    return result
}

/**
 * The Agreement of the Order or Return order a work order was initiated from (ADR 0018), for its currency; null when
 * that record names none, or the work is for neither (a site audit's).
 */
function workOrderAgreement(workOrder: GlideRecord): AgreementCurrency | null {
    const sourceId = str(workOrder, 'initiated_from')
    if (!sourceId) return null
    const source = findById('x_daas_ham_order', sourceId) ?? findById('x_daas_ham_return_order', sourceId)
    return source && agreementCurrencyOf(source, 'agreement')
}

/**
 * Shipments whose label was bought in the month, as Cost facts of their Customer and Site in the carrier's currency
 * (domain/shipping `buyLabel`), never converted. A voided label is refunded, so it is left out; one with a cost but no
 * currency or no Customer (a Cost fact needs both) is left out and counted.
 */
function addShippingCosts(periodId: string, bounds: MonthBounds): Failed {
    const ledger = new CostLedger()
    const result: Failed = { failed: 0, lastError: '' }
    const shipment = new GlideRecord('x_daas_ham_shipment')
    shipment.addEncodedQuery(`status!=${SHIPMENT_STATUS.voided}^cost>0^sys_created_on>=${bounds.first} 00:00:00^sys_created_on<=${bounds.last} 23:59:59`)
    shipment.query()
    while (shipment.next()) {
        const currency = currencyCode(str(shipment, 'currency'))
        const customerId = str(shipment, 'customer')
        // CostLedger.add drops a cost without a Customer, so it is counted here rather than lost without a word.
        const missing = !currency ? 'its cost has no currency' : !customerId ? 'it has no Customer to cost it to' : ''
        if (missing) {
            result.failed++
            const name = str(shipment, 'number') || str(shipment, 'tracking_number') || shipment.getUniqueValue()
            result.lastError = `shipment ${name}: ${missing}`
            continue
        }
        ledger.add({ customerId, siteId: str(shipment, 'site'), type: 'shipping', currency, amount: num(shipment, 'cost') })
    }
    writeCostFacts(periodId, ledger.drain())
    return result
}

/**
 * The amounts of a table's records matching an encoded query, summed per Customer, Site and currency. The currency is
 * read as Billing period totals read it (domain/billing `currencyKey`): a line edited during review to 'eur' is set
 * against the 'EUR' costs of its Customer and Site (marginRows merges the rows of one key).
 */
function sumsBy(table: string, encodedQuery: string): Amount[] {
    const ga = new GlideAggregate(table)
    ga.addEncodedQuery(encodedQuery)
    ga.addAggregate('SUM', 'amount')
    ga.groupBy('customer')
    ga.groupBy('site')
    ga.groupBy('currency')
    ga.query()
    const sums: Amount[] = []
    while (ga.next()) {
        sums.push({
            customerId: String(ga.getValue('customer') ?? ''),
            siteId: String(ga.getValue('site') ?? ''),
            currency: currencyKey(String(ga.getValue('currency') ?? '')),
            amount: Number(ga.getAggregate('SUM', 'amount')) || 0,
        })
    }
    return sums
}

/**
 * Replace the period's Margin rows with its revenue against its Cost facts, one row per Customer, Site and currency.
 * They are cleared again here, as one a pass that lost the job's lock wrote since this pass started would sit beside
 * these (ADR 0013). A row left throws (see clearRows).
 */
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
        margin.setValue('currency', row.currency)
        margin.setValue('revenue', row.revenue)
        margin.setValue('cost', row.cost)
        margin.setValue('margin', row.margin)
        margin.setValue('margin_pct', row.marginPct ?? '')
        if (!margin.insert()) throwRefused(margin, 'Margin row not saved')
    }
}
