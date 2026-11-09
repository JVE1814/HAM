import { GlideDateTime, GlideRecord, gs } from '@servicenow/glide'
import { appendTo } from '../domain/collections.ts'
import { fleetStagesQuery } from '../domain/fleet.ts'
import { isDeployed } from '../domain/lifecycle.ts'
import {
    chargedFeeQuery,
    feeAmount,
    feeLockName,
    INSTALLED_STAGES,
    returnDueDate,
    SITE_RECOVERY_STAGES,
    type FeeIdentity,
    type FeeType,
} from '../domain/returns.ts'
import { isFleetAsset, moveAndSave, readStage } from './assets.ts'
import { todayIso } from './clock.ts'
import { openFieldWork } from './field-work.ts'
import { withLockTries, type HeldLock } from './locks.ts'
import { exists, findById, num, refusal, str } from './records.ts'

/** Return orders, their lines and Fee events (P2.4). */

export type ReturnTrigger =
    | 'site_decommission'
    | 'device_removal'
    | 'refresh_swap_back'
    | 'defective_return'
    | 'agreement_end'
    | 'temporary_end'

export interface ReturnRequest {
    trigger: ReturnTrigger
    customerId: string
    siteId: string
    agreementId: string
    method: 'fsm_deinstall' | 'ship_back'
    assetIds: readonly string[]
    sourceOrderId?: string
    /** Open a de-install change + work order (not when an existing swap work order collects the unit). */
    openFieldWork: boolean
    description: string
}

/**
 * Create a Return order with one line per Asset; installed or shipped Assets become pending return. Null, with a
 * warning, when the platform refuses the Return order: no Asset is touched, so the caller can raise it again.
 */
export function raiseReturn(request: ReturnRequest): string | null {
    const order = new GlideRecord('x_daas_ham_return_order')
    order.initialize()
    order.setValue('trigger', request.trigger)
    order.setValue('customer', request.customerId)
    order.setValue('site', request.siteId)
    order.setValue('agreement', request.agreementId)
    order.setValue('method', request.method)
    order.setValue('source_order', request.sourceOrderId ?? '')
    order.setValue('short_description', request.description)
    const orderId = order.insert()
    if (!orderId) {
        const reason = refusal(order)
        gs.warn(`[x_daas_ham] Return not raised (${request.description}): ${reason}`)
        return null
    }
    completeReturn(order, request)
    return orderId
}

/**
 * Fill in a saved Return order header: due date, lines, de-install work. Only fleet assets (ADR 0016) get a line: one
 * of the Provider IT's that a caller lists is left off (logged), so no app job ever chases, declares or charges it. Each
 * Asset is put on it under its return lock (`returnAssetLockName`), so it awaits one Return at a time.
 */
export function completeReturn(order: GlideRecord, request: ReturnRequest): void {
    const agreement = findById('x_daas_ham_agreement', request.agreementId)
    const allowance = agreement ? num(agreement, 'overdue_return_days') || 30 : 30
    order.setValue('agreement', request.agreementId)
    order.setValue('due_back', returnDueDate(todayIso(), allowance))
    order.setValue('state', 2)

    let lines = 0
    let refused = 0
    for (const assetId of request.assetIds) {
        const added = addUnderLock(order, assetId)
        if (added === 'added') lines++
        else if (added === 'refused') refused++
    }

    if (lines === 0) {
        // Nothing installed, everything already on another Return order, or every unit refused: close straight away.
        order.setValue('state', 3)
        const note = refused > 0 ? 'No unit could be added (see the system log).' : 'No equipment to bring back.'
        order.setValue('work_notes', note)
    } else if (request.openFieldWork && request.method === 'fsm_deinstall') {
        const context = {
            customerId: request.customerId,
            siteId: request.siteId,
            description: request.description,
            source: { field: 'x_daas_ham_return_order' as const, id: order.getUniqueValue() },
        }
        const work = openFieldWork(context, { changeType: 'normal', purpose: 'de_install', subcontracted: false })
        if (work) {
            order.setValue('change_request', work.changeId)
            order.setValue('work_order', work.workOrderId)
        } else {
            order.setValue('work_notes', 'De-install work not opened (see the system log): open it by hand.')
        }
    }
    // Its lines and moves are saved, but a Return without its due date is never chased: logged to set it by hand.
    if (!order.update()) {
        gs.warn(`[x_daas_ham] Return ${str(order, 'number')} due date, state and links not saved: ${refusal(order)}`)
    }
}

/** What came of putting an Asset on a Return order: a line added, refused (logged), or none needed. */
type LineResult = 'added' | 'refused' | 'skipped'

/** Tries at an Asset's return lock, back to back: a holder holds it for one check, one line and one move. */
const RETURN_LOCK_TRIES = 5

/**
 * The job lock (ADR 0013) an Asset is put on a Return order under. The check that it awaits no other return and the
 * insert of its line are one critical section, so two Returns raised at once (a request sent twice, the record producer
 * beside the customer page or an Agreement's end) never both take the unit, which would leave the line it is not
 * received on to be declared missing and charged as lost. No unique index can hold it: an Asset is on one awaiting
 * line at a time, but on any number of settled ones.
 */
function returnAssetLockName(assetId: string): string {
    return `return_asset_${assetId}`
}

/**
 * The job lock (ADR 0013) a Customer's return requests from the customer page are raised under, one at a time
 * (entry/customer `requestCustomerReturn`): a request sent twice raises one Return order, with one de-install work
 * order and change, not two.
 */
export function returnRequestLockName(customerId: string): string {
    return `return_request_${customerId}`
}

/** Whether the Asset is on a Return order line still awaiting it. */
export function awaitsReturn(assetId: string): boolean {
    return latestReturnLine(assetId, 'awaiting') !== null
}

/**
 * Put the Asset on the Return order under its return lock (`returnAssetLockName`); 'skipped' when it is not found,
 * already awaits a return, or another Return held its lock through every try and has taken it. One whose lock was held
 * through every try but that still awaits no return (the holder was slow, refused or died holding it) is 'refused',
 * logged, as is one whose lock cannot be taken (platform/locks throws); the line's own errors escape.
 */
function addUnderLock(order: GlideRecord, assetId: string): LineResult {
    let result = 'skipped' as LineResult
    // Set inside the lock: only a lock that could not be taken is caught.
    let started = false as boolean
    try {
        const ran = withLockTries(returnAssetLockName(assetId), RETURN_LOCK_TRIES, (lock) => {
            started = true
            const added = addLineHolding(lock, order, assetId)
            // Lost before the line was written: the try is given up, and the next checks afresh.
            if (added === null) return false
            result = added
            return true
        })
        if (ran) return result
        // The holder has normally put it on its Return by now; one that has not leaves the unit on none (as recordFee).
        if (awaitsReturn(assetId)) {
            gs.info(`[x_daas_ham] Asset ${assetId} left off return ${str(order, 'number')}: another return held its lock and took it`)
            return 'skipped'
        }
        gs.warn(`[x_daas_ham] Asset ${assetId} left off return ${str(order, 'number')}: its return lock was held through every try, yet it awaits no return: put it on one by hand if it is due back`)
        return 'refused'
    } catch (error) {
        if (started) throw error
        gs.warn(`[x_daas_ham] Asset ${assetId} left off return ${str(order, 'number')}: ${errorText(error)}`)
        return 'refused'
    }
}

/**
 * Add the Asset's line and make it pending return, holding its return `lock`. A holder that outlasts the lock (ADR
 * 0013) and lost it before the insert writes nothing (null); one that lost it during the insert is logged, to check
 * the unit is on one Return.
 */
function addLineHolding(lock: HeldLock, order: GlideRecord, assetId: string): LineResult | null {
    const asset = findById('alm_hardware', assetId)
    if (!asset || awaitsReturn(assetId)) return 'skipped'
    if (!isFleetAsset(asset)) {
        gs.warn(`[x_daas_ham] ${str(asset, 'serial_number')} left off return ${str(order, 'number')}: it is not a fleet asset`)
        return 'refused'
    }
    if (!lock.held()) return null
    // The line first: an Asset whose line is refused stays as it is, off this Return order.
    const line = new GlideRecord('x_daas_ham_return_order_line')
    line.initialize()
    line.setValue('return_order', order.getUniqueValue())
    line.setValue('asset', assetId)
    if (!line.insert()) {
        const reason = refusal(line)
        gs.warn(`[x_daas_ham] ${str(asset, 'serial_number')} left off return ${str(order, 'number')}: ${reason}`)
        return 'refused'
    }
    if (!lock.held()) {
        gs.warn(`[x_daas_ham] ${str(asset, 'serial_number')} put on return ${str(order, 'number')} after its lock was lost: check it is on one return`)
    }
    const stage = readStage(asset)
    const moving = isDeployed(stage) && stage !== 'pending_return'
    // Leaving service closes the Asset's service interval (entry/assets.ts onAssetServiceChange). A refused move
    // (moveAndSave warns) takes the line off again: it would await a unit still in service, later declared missing.
    // One that cannot be taken off is logged, to remove by hand before the overdue job gets to it.
    if (moving && !moveAndSave(asset, 'pending_return', `return ${str(order, 'number')}`)) {
        if (line.deleteRecord()) return 'refused'
        const kept = `${str(asset, 'serial_number')} not pending return but kept on return ${str(order, 'number')}`
        gs.warn(`[x_daas_ham] ${kept}: ${refusal(line, 'delete refused')}; remove its line`)
    }
    return 'added'
}

export interface InstalledFilter {
    agreementId?: string
    siteId?: string
    orderId?: string
    /** A whole-Site recovery: also the units still shipped there (domain/returns `SITE_RECOVERY_STAGES`). */
    wholeSite?: boolean
}

/**
 * Fleet assets installed at a Site (in service, temporary or awaiting first sighting, and shipped there for a
 * whole-Site recovery), by Agreement, Site or Order. The Provider IT's equipment is never listed (ADR 0016).
 */
export function installedAssetIds(filter: InstalledFilter): string[] {
    const asset = queryInstalled(filter)
    const ids: string[] = []
    while (asset.next()) ids.push(asset.getUniqueValue())
    return ids
}

/** The installed Assets (as installedAssetIds) under the Site each is at. */
export function installedAssetIdsBySite(filter: InstalledFilter): Map<string, string[]> {
    const asset = queryInstalled(filter)
    const bySite = new Map<string, string[]>()
    while (asset.next()) appendTo(bySite, str(asset, 'x_daas_ham_site'), asset.getUniqueValue())
    return bySite
}

function queryInstalled(filter: InstalledFilter): GlideRecord {
    const base = [
        filter.agreementId ? `x_daas_ham_agreement=${filter.agreementId}` : '',
        filter.siteId ? `x_daas_ham_site=${filter.siteId}` : '',
        filter.orderId ? `x_daas_ham_order_line.order=${filter.orderId}` : '',
    ]
        .filter(Boolean)
        .join('^')
    const asset = new GlideRecord('alm_hardware')
    asset.addEncodedQuery(fleetStagesQuery(filter.wholeSite ? SITE_RECOVERY_STAGES : INSTALLED_STAGES, base))
    asset.query()
    return asset
}

/** The return line an arriving Asset settles: awaiting, or declared missing and now turning up late. */
export function expectedReturnLine(assetId: string): GlideRecord | null {
    return latestReturnLine(assetId, 'awaiting,missing')
}

function latestReturnLine(assetId: string, statuses: string): GlideRecord | null {
    const line = new GlideRecord('x_daas_ham_return_order_line')
    line.addQuery('asset', assetId)
    line.addQuery('status', 'IN', statuses)
    line.orderByDesc('sys_created_on')
    line.setLimit(1)
    line.query()
    return line.next() ? line : null
}

/** Waive the not-yet-billed fees of one type charged for an Asset on a Return order. */
export function waiveOpenFees(type: FeeType, assetId: string, returnOrderId: string): void {
    const fee = new GlideRecord('x_daas_ham_fee_event')
    fee.addQuery('fee_type', type)
    fee.addQuery('asset', assetId)
    fee.addQuery('return_order', returnOrderId)
    fee.addQuery('status', 'open')
    fee.query()
    while (fee.next()) {
        fee.setValue('status', 'waived')
        // Left open, it is billed for a unit that came back.
        if (!fee.update()) gs.warn(`[x_daas_ham] ${type} fee ${fee.getUniqueValue()} not waived: ${refusal(fee)}`)
    }
}

/** Tries at taking a fee's lock before leaving the fee to the holder: it holds it for one check and one insert. */
const FEE_LOCK_ATTEMPTS = 5

/**
 * Charge a Fee event of `type` for the Asset on the Return order, once (domain/returns `chargedFeeQuery`): a step
 * retried after a refused save (an evaluation chosen again, a line declared missing again) does not charge it twice.
 * Two runs may also charge it at the same time (two users saving one line's evaluation, overlapping overdue runs; two
 * scans of one unit already take turns under its receive lock, entry/warehouse). A unique index on the fee's identity
 * would also refuse a fee charged after a waived one, so the check and the insert are made under a lock on the fee,
 * re-checking there (as platform/exceptions `openException`). A run that finds the lock held through every try leaves
 * the fee to the holder, which is charging it. A fee that is refused, that the holder has still not charged when this
 * run gives up, or whose lock cannot be taken (platform/locks throws) is logged, not thrown.
 */
export function recordFee(type: FeeType, asset: GlideRecord, returnOrderId: string): void {
    const fee: FeeIdentity = { type, assetId: asset.getUniqueValue(), returnOrderId }
    // A retried step mostly finds the fee charged already: that needs no lock.
    if (isCharged(fee)) return
    const agreement = findById('x_daas_ham_agreement', str(asset, 'x_daas_ham_agreement'))
    const amount = feeAmount(type, {
        lost: agreement ? num(agreement, 'lost_asset_fee') : 0,
        damaged: agreement ? num(agreement, 'damage_fee') : 0,
        late_return: agreement ? num(agreement, 'late_return_fee') : 0,
    })
    if (amount <= 0) return
    // Set inside the lock: the fee's own errors escape, and only a lock that could not be taken is logged.
    let started = false as boolean
    let why = 'left to a run holding its lock, which has not recorded it yet'
    try {
        const ran = withLockTries(feeLockName(fee), FEE_LOCK_ATTEMPTS, (lock) => {
            started = true
            if (!isCharged(fee)) chargeHolding(lock, fee, asset, amount)
        })
        if (ran) return
    } catch (error) {
        if (started) throw error
        why = errorText(error)
    }
    // The holder has normally charged it by now; one that has not may be slow, or have died holding the lock.
    if (isCharged(fee)) return
    gs.warn(`[x_daas_ham] ${type} fee for ${str(asset, 'serial_number')} not recorded: ${why}; check its Fee events`)
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function isCharged(fee: FeeIdentity): boolean {
    return exists('x_daas_ham_fee_event', chargedFeeQuery(fee))
}

/**
 * Insert the fee holding `lock`. A holder that outlasts the lock (ADR 0013) may overlap the run that took it over and
 * charges the fee too: one that lost it before the insert leaves the fee to that run, one that lost it during the
 * insert is logged.
 */
function chargeHolding(lock: HeldLock, fee: FeeIdentity, asset: GlideRecord, amount: number): void {
    if (!lock.held()) return
    const record = new GlideRecord('x_daas_ham_fee_event')
    record.initialize()
    record.setValue('fee_type', fee.type)
    record.setValue('customer', str(asset, 'company'))
    record.setValue('agreement', str(asset, 'x_daas_ham_agreement'))
    record.setValue('asset', fee.assetId)
    record.setValue('return_order', fee.returnOrderId)
    record.setValue('amount', amount)
    record.setValue('occurred_on', todayIso())
    const what = `${fee.type} fee for ${str(asset, 'serial_number')}`
    if (!record.insert()) gs.warn(`[x_daas_ham] ${what} not recorded: ${refusal(record)}`)
    else if (!lock.held()) gs.warn(`[x_daas_ham] ${what} recorded after its lock was lost: check it is charged once`)
}

/** Close a Return order once every line is evaluated or declared missing. */
export function closeReturnIfDone(returnOrderId: string): void {
    const open = new GlideRecord('x_daas_ham_return_order_line')
    open.addQuery('return_order', returnOrderId)
    open.addQuery('status', 'IN', 'awaiting,received')
    open.setLimit(1)
    open.query()
    if (open.hasNext()) return
    const order = findById('x_daas_ham_return_order', returnOrderId)
    if (!order || str(order, 'state') === '3') return
    order.setValue('state', 3)
    // No later line calls this again, and an open Return still asks the Customer for its equipment.
    if (!order.update()) gs.warn(`[x_daas_ham] Return ${str(order, 'number')} not closed: ${refusal(order)}; close it`)
}

export function stampNow(record: GlideRecord, field: string): void {
    record.setValue(field, new GlideDateTime().getValue())
}
