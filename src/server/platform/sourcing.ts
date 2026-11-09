import { gs, GlideRecord } from '@servicenow/glide'
import { appendTo } from '../domain/collections.ts'
import { LONG_HOLD_LOCK_TRIES, REQUEUE, type HeldLock } from '../domain/job-lock.ts'
import { LOCK } from '../domain/lock-names.ts'
import type { ShortfallRoute } from '../domain/returns.ts'
import {
    advanceReplacementRma,
    lineShortfall,
    lineStillOpen,
    needsTransfer,
    planSourcing,
    shortfallOutcome,
    shortfallRouteFor,
    sourcingPurpose,
    stillToBuy,
    type Source,
    type SourcingRequest,
    type UnmovedStock,
} from '../domain/sourcing.ts'
import type { OrderType } from '../domain/vocabulary.ts'
import { moveAndSave } from './assets.ts'
import { todayIso } from './clock.ts'
import { EVENT, requeue } from './events.ts'
import { lineLostUnit, recomputeLine, recomputeOrder, unitsOnLine } from './fulfilment.ts'
import { withLock, withLockTries, type LockRun } from './locks.ts'
import { openOemRma, openRmaCount, openRmasFor, reuseOemRma } from './oem-rma.ts'
import { requestPurchase } from './procurement.ts'
import { stagingStockroom } from './properties.ts'
import { findById, num, str, warnRefused } from './records.ts'
import { openStagingTask, skipOpenStagingTasks, startStaging } from './staging-tasks.ts'
import { linkHotSpare, releaseToProviderStock, reserveAsset, stockCandidates } from './stock.ts'
import { requestTransfer } from './transfers.ts'

/**
 * Sourcing an Order's lines (ADR 0004): allocate stock, request transfers and purchases, and put back what could not
 * be moved. Stages after sourcing are derived from Asset stages (platform/fulfilment).
 */

/** How sourcing left a line: done (sourced, or a refused save logged), or for a pass queued again to finish. */
type LineSourcing = 'done' | 'line busy' | 'lock lost'

const AGAIN_BECAUSE: Record<Exclude<LineSourcing, 'done'>, string> = {
    'line busy': "a line's lock stayed held",
    'lock lost': "the Order's sourcing lock was lost",
}

/**
 * One sourcing pass over `order`, for a request queued again `queuedAgain` times: allocate stock, request transfers
 * and purchases for its lines that are new or awaiting stock.
 *
 * Two passes over one Order (two staging tasks failed seconds apart, or one failed while the first pass runs) would
 * count the same shortfall, and one would buy what the other claimed. So a pass holds a lock on the Order, which Cancel
 * order holds too (platform/orders `cancelOrder`). One that finds it held runs again a minute later rather than leave
 * its work to the holder, which may have counted before the change that queued it; so does a pass that left a line
 * whose lock stayed held, or that lost the Order's lock. A request is queued again a minute apart and past the lock's
 * abandonment (domain/job-lock `REQUEUE`), then dropped with a warning: a lock still held by then was taken after the
 * request was queued, by a pass that counted its change. Taking the lock throws only when an insert is refused with no
 * lock row (platform/locks): that error escapes.
 */
export function runSourcingPass(order: GlideRecord, queuedAgain: number): void {
    const orderId = order.getUniqueValue()
    const pass = withLock(LOCK.sourceOrder(orderId), (lock) => {
        let again: Exclude<LineSourcing, 'done'> | null = null
        const line = new GlideRecord('x_daas_ham_order_line')
        line.addQuery('order', orderId)
        line.addQuery('line_stage', 'IN', 'new,awaiting_stock')
        line.query()
        while (again !== 'lock lost' && line.next()) {
            const sourced = sourceLine(lock, order, line)
            if (sourced !== 'done') again = sourced
        }
        return again
    })
    const again = pass.ran ? pass.value : null
    if (!pass.ran || again) {
        const why = again ? AGAIN_BECAUSE[again] : 'another pass or a cancel holds its lock'
        queuePassAgain(order, queuedAgain, why)
    }
    if (pass.ran) recomputeOrder(orderId)
}

/** Queue the request to source `order` again a minute later, unless it was already queued again `tries` times. */
function queuePassAgain(order: GlideRecord, tries: number, why: string): void {
    const number = str(order, 'number')
    if (tries >= REQUEUE.times) {
        return void gs.warn(`[x_daas_ham] ${number} not sourced again after ${tries} tries (${why}): check its lines`)
    }
    gs.info(`[x_daas_ham] ${number} sourced again in ${REQUEUE.delaySeconds} s: ${why}`)
    requeue(EVENT.sourceOrder, order, '', String(tries + 1))
}

/**
 * Run `work` holding the Order line's lock and give what it returned, or `ran: false` when other holders kept it through
 * every try: a holder keeps it for a receipt (the Asset, the line and the reservation saved) or for sourcing's read of
 * the line or its purchase and save. Taking the lock throws only when an insert is refused with no lock row
 * (platform/locks `withLockTries` tries again, and that error escapes only when every try threw), as does an error
 * from `work`.
 */
export function withOrderLineLock<T>(lineId: string, work: (lock: HeldLock) => T): LockRun<T> {
    return withLockTries(LOCK.orderLine(lineId), work, LONG_HOLD_LOCK_TRIES)
}

/** What sourcing found and did for a line outside its lock: what `settleHolding` routes, buys and saves. */
interface Sourced {
    lineId: string
    modelId: string
    /** Routes what is still missing when the line is saved (domain/sourcing `shortfallRouteFor`). */
    route: (missing: number) => ShortfallRoute
    /** The Asset a break-fix line replaces, which an OEM advance replacement is asked for. */
    replaced: GlideRecord | null
    /** What the pass would buy by its own read: the shortfall less the stock it claimed. */
    toPurchase: number
    /** Claimed units put back for want of a transfer order: missing again, but not bought (`shortfallOutcome`). */
    putBack: number
    planSummary: string
    unmoved: UnmovedStock[]
    transfers: string[]
}

/** Source one line holding the Order's `orderLock`; see `LineSourcing`. */
function sourceLine(orderLock: HeldLock, order: GlideRecord, line: GlideRecord): LineSourcing {
    // A pass that outlasted the Order's lock (ADR 0013) may overlap the one that took it over: it sources nothing more.
    if (!orderLock.held()) return leftUnsaved(line, 'lock lost', [])
    const lineId = line.getUniqueValue()
    // Read under the line's lock, where a receipt takes its unit off order and allocates it: seen whole or not at all.
    const read = withOrderLineLock(lineId, () => openLineShortfall(lineId))
    if (!read.ran) return 'line busy'
    const shortfall = read.value
    if (shortfall === null || shortfall <= 0) return 'done'

    const modelId = str(line, 'model')
    const customerId = str(order, 'customer')
    const purpose = sourcingPurpose(str(order, 'order_type') as OrderType | '')
    const request: SourcingRequest = { modelId, quantity: shortfall, customerId, siteId: str(order, 'site'), purpose }
    const plan = planSourcing(request, stockCandidates(request, shortfall))

    const stagingId = stagingStockroom()
    const reservation = { orderLineId: lineId, customerId, agreementId: str(order, 'agreement') }
    const toStage: GlideRecord[] = []
    const toTransfer = new Map<string, Array<{ asset: GlideRecord; source: Source }>>()
    let reserved = 0
    for (const pick of plan.picks) {
        // A hot spare already at the customer site needs no staging or shipping: it is installed from where it is.
        if (pick.source === 'customer_site_stock') {
            if (linkHotSpare(pick.assetId, reservation)) reserved++
            continue
        }
        const asset = reserveAsset(pick.assetId, reservation)
        if (!asset) continue
        reserved++
        const from = str(asset, 'stockroom')
        if (needsTransfer(from, stagingId)) appendTo(toTransfer, from, { asset, source: pick.source })
        else toStage.push(asset)
    }
    // Stock outside the staging centre is in transfer to it once its transfer order exists; without one it goes back.
    const transfers: string[] = []
    const unmoved: UnmovedStock[] = []
    const inTransfer: GlideRecord[] = []
    let putBack = 0
    for (const [from, picked] of toTransfer) {
        const assets = picked.map(({ asset }) => asset)
        const transfer = requestTransfer({ fromStockroomId: from, toStockroomId: stagingId, modelId, assets })
        if (transfer.ok) {
            transfers.push(transfer.transferId)
            inTransfer.push(...assets)
            continue
        }
        unmoved.push({ units: picked.length, from: picked[0].asset.getDisplayValue('stockroom'), reason: transfer.reason })
        for (const { asset, source } of picked) {
            // As Inventory left it once its line was removed (platform/transfers `requestTransfer`).
            const fresh = findById('alm_hardware', asset.getUniqueValue())
            if (fresh && unreserve(fresh, source)) putBack++
        }
    }
    for (const asset of toStage) startStaging(asset, lineId, 'sourcing')
    // A unit in transfer gets its Staging task now and goes into staging when its line is received at the staging
    // centre (entry/assets `onTransferReleased`); without the task it is reserved for the line there.
    for (const asset of inTransfer) openStagingTask(asset, lineId)
    // Unmoved stock is not bought (see shortfallOutcome).
    const toPurchase = shortfall - reserved
    // Only a break-fix line can be served by the OEM's advance replacement (domain/sourcing `shortfallRouteFor`).
    const replaced = purpose === 'replace' ? findById('alm_hardware', str(line, 'replaces_asset')) : null
    const replacedUnit = replaced && { modelId: str(replaced, 'model'), coverageEnd: str(replaced, 'x_daas_ham_coverage_end') }
    const today = todayIso()
    const route = (missing: number) => shortfallRouteFor(modelId, replacedUnit, today, missing)
    const planSummary = plan.summary
    const sourced: Sourced = { lineId, modelId, route, replaced, toPurchase, putBack, planSummary, unmoved, transfers }
    const settling = withOrderLineLock(lineId, (lineLock) => settleHolding(orderLock, lineLock, order, sourced))
    const settled = settling.ran ? settling.value : 'line busy'
    if (settled === 'saved') recomputeLine(lineId)
    if (settled === 'closed') leftClosed(line, transfers)
    if (settled === 'saved' || settled === 'unsaved' || settled === 'closed') return 'done'
    return leftUnsaved(line, settled, transfers)
}

/**
 * Units the line still needs, read afresh (`shortfallOf`). Null for a line gone or no longer open, so nothing is
 * reserved for it.
 */
function openLineShortfall(lineId: string): number | null {
    const line = openLine(lineId)
    return line ? shortfallOf(line, unitsOnLine(lineId)) : null
}

/** Units the open `line` still needs beside its `allocated` ones (domain/sourcing `lineShortfall`). */
function shortfallOf(line: GlideRecord, allocated: number): number {
    return lineShortfall({
        quantity: num(line, 'quantity'),
        allocated,
        onOrder: num(line, 'quantity_to_purchase'),
        awaitedRmas: openRmaCount(line.getUniqueValue()),
    })
}

/**
 * The line read afresh while it and its Order are still open (domain/sourcing `lineStillOpen`), else null. Cancel
 * order takes turns with sourcing under the Order's lock, but a rejected Order's lines are cancelled without that lock,
 * a cancel may overlap a pass that outlasted it (ADR 0013), and a line whose cancel was refused stays open on its
 * cancelled Order; so sourcing checks the line here before it reserves, buys or saves. The Order is saved as cancelled
 * or rejected before its lines, so it is checked too.
 */
function openLine(lineId: string): GlideRecord | null {
    const line = findById('x_daas_ham_order_line', lineId)
    const open = line && lineStillOpen({ lineStage: str(line, 'line_stage'), orderStage: str(line, 'order.stage') })
    return open ? line : null
}

/**
 * Route what the line still misses and save it, holding its `lineLock` and the Order's. The stock pick ran outside the
 * line's lock, so receipts may have changed its counts since: what is bought is worked out again from a fresh read
 * (domain/sourcing `stillToBuy`) and added to the on-order count and purchase orders as they now stand. 'closed' when
 * the line is gone or no longer open (`openLine`), 'unsaved' when its save is refused (logged).
 */
function settleHolding(
    orderLock: HeldLock,
    lineLock: HeldLock,
    order: GlideRecord,
    sourced: Sourced,
): 'saved' | 'unsaved' | 'closed' | 'lock lost' {
    // Buying is what two overlapping passes must not both do.
    if (!orderLock.held()) return 'lock lost'
    const line = openLine(sourced.lineId)
    if (!line) return 'closed'
    const number = str(line, 'number')
    const allocated = unitsOnLine(sourced.lineId)
    const missing = stillToBuy(sourced.toPurchase, shortfallOf(line, allocated), sourced.putBack)
    const route = sourced.route(missing)
    const advance = route === 'oem_advance_replacement' && sourced.replaced
    const rmaNote = advance ? putUnderRma(order, line, advance) : ''
    const { toPurchase, unmoved, transfers } = sourced
    // The plan's summary counts what the pass would buy by its own read.
    const met = toPurchase - missing
    const planSummary =
        met > 0 ? `${sourced.planSummary} (${met} not bought: met since the line was counted)` : sourced.planSummary
    const purchase = () =>
        requestPurchase({
            modelId: sourced.modelId,
            quantity: missing,
            description: `${str(order, 'number')} ${number}: ${missing} x ${str(line, 'model.display_name')}`,
        })
    const outcome = shortfallOutcome(route, { planSummary, missing, unmoved }, purchase)
    if (transfers.length > 0) {
        line.setValue('transfer_orders', [str(line, 'transfer_orders'), ...transfers].filter(Boolean).join(','))
    }
    if (outcome.purchaseOrder) {
        // Every purchase order stays listed, so units of an earlier one are still allocated to the line on receipt.
        const listed = [str(line, 'purchase_orders'), outcome.purchaseOrder].filter(Boolean)
        line.setValue('purchase_order', outcome.purchaseOrder)
        line.setValue('purchase_orders', listed.join(','))
    }
    // Counted again: a receipt may have allocated a unit to the line since this pass read it.
    line.setValue('quantity_allocated', allocated)
    line.setValue('quantity_to_purchase', num(line, 'quantity_to_purchase') + outcome.purchased)
    line.setValue('sourcing_summary', `${outcome.summary}${rmaNote}`)
    line.setValue('line_stage', outcome.stage)
    if (!line.update()) {
        // Unlisted, a purchase order's units are not allocated on receipt, and the next run buys the shortfall again.
        const unlisted = [outcome.purchaseOrder ?? '', ...transfers].filter(Boolean)
        const listThem = unlisted.length > 0 ? `; it does not list ${unlisted.join(', ')}, add them by hand` : ''
        warnRefused(line, `${number} not saved after sourcing${listThem}`)
        return 'unsaved'
    }
    // A holder that outlasted the line's lock (ADR 0013) may have saved beside a receipt that took it over.
    lineLock.lostAfter(`${number} saved`, { check: 'check its On order count' })
    return 'saved'
}

/**
 * Put the line's shortfall under an OEM advance replacement for the Asset it `replaced`: the RMA already open for that
 * unit when there is one to reuse (domain/sourcing `advanceReplacementRma`), else a new one. What the line's sourcing
 * summary adds. Unrecorded, the line would wait for a replacement nobody asked the OEM for: logged and in its summary.
 */
function putUnderRma(order: GlideRecord, line: GlideRecord, replaced: GlideRecord): string {
    const lineId = line.getUniqueValue()
    const serial = str(replaced, 'serial_number')
    const reuse = advanceReplacementRma(lineId, openRmasFor(replaced.getUniqueValue()))
    if (reuse) {
        const which = `RMA ${reuse.rma.rmaNumber || '(no number yet)'} already open for ${serial}`
        if (!reuseOemRma(reuse, lineId)) return ` (${which} not put under the line: do it by hand)`
        return reuse.askAgain ? ` (${which}: its replacement was received, ask the vendor for another)` : ` (${which})`
    }
    if (openOemRma({ defectiveAsset: replaced, orderLineId: lineId, caseId: str(order, 'case') })) return ''
    gs.warn(`[x_daas_ham] ${str(line, 'number')}: no OEM RMA saved for ${serial}`)
    return ' (none saved: open it by hand)'
}

/**
 * Log a line gone or closed while this pass picked stock for it (see `openLine`): nothing is bought or saved for it,
 * and what the pass reserved and requested meanwhile is named, to undo by hand.
 */
function leftClosed(line: GlideRecord, transfers: readonly string[]): void {
    const units = unitsOnLine(line.getUniqueValue())
    const release = units > 0 ? `; release the ${units} unit(s) still on it` : ''
    const cancel = transfers.length > 0 ? `; cancel ${transfers.join(', ')}` : ''
    gs.warn(`[x_daas_ham] ${str(line, 'number')} closed while it was sourced: nothing bought for it${release}${cancel}`)
}

/** Log a line left to the pass queued again, naming the transfer orders it does not list. */
function leftUnsaved(line: GlideRecord, why: keyof typeof AGAIN_BECAUSE, transfers: readonly string[]): LineSourcing {
    const listThem = transfers.length > 0 ? `; it does not list ${transfers.join(', ')}, add them by hand` : ''
    gs.warn(`[x_daas_ham] ${str(line, 'number')} left to the next sourcing pass (${AGAIN_BECAUSE[why]})${listThem}`)
    return why
}

/**
 * Put back stock reserved for a line but never moved to staging: Spare-pool stock to the pool, still its Customer's,
 * the rest to the Provider's free stock. False when the platform refuses (logged with `why`): the Asset stays on the
 * line.
 */
function unreserve(asset: GlideRecord, source: Source, why = 'no transfer order'): boolean {
    if (source === 'spare_pool') {
        asset.setValue('x_daas_ham_order_line', '')
        return moveAndSave(asset, 'spare_pool', why)
    }
    releaseToProviderStock(asset)
    return moveAndSave(asset, 'available', why)
}

/**
 * A unit's transfer to the staging centre fell through (`current` as its after-update rule sees it, entry/assets
 * `onAllocatedAssetStageChange`): Inventory let it go short of the staging centre, its transfer order line cancelled
 * or deleted, and it was reserved for its line again where it was, which nothing moves it on from (domain/lifecycle
 * `transferFellThrough`). So it is put back as stock is for want of a transfer order, as free stock: the Source it was
 * picked from is no longer known (the spare-pool top-up replaces a spare). Its Staging task is skipped, its line
 * derived again (back to awaiting stock) and its Order sourced again, queued, which picks stock again and may raise a
 * new transfer order for the same unit (platform/fulfilment `lineLostUnit`). Logged. A unit the platform refuses to
 * put back stays reserved for its line (logged), which is then not sourced again.
 */
export function putBackUntransferred(current: GlideRecord, lineId: string): void {
    const where = current.getDisplayValue('stockroom')
    const what = `${str(current, 'serial_number')} left its transfer to the staging centre in ${where}`
    // A fresh record, read past the user's rules: saving `current` again from its own after rule would run its rules
    // twice, and an inventory tech of the staging centre who cancelled the line does not see a unit stored elsewhere.
    const asset = findById('alm_hardware', current.getUniqueValue(), { beyondVisibility: true })
    if (!asset) return
    if (!unreserve(asset, 'central_stock', `${what}, so it is put back`)) return
    skipOpenStagingTasks(asset.getUniqueValue(), 'Transfer to the staging centre fell through')
    lineLostUnit(lineId)
    gs.warn(`[x_daas_ham] ${what}: put back as free stock, its line sourced again`)
}
