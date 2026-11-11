import { GlideRecord, gs } from '@servicenow/glide'
import { normalizeSerial } from '../domain/serials.ts'
import { naasStockroomType, OEM_PID_FIELD, receiptProblem, STOCKROOM_TYPE_FIELD } from '../domain/fleet.ts'
import type { HeldLock } from '../domain/job-lock.ts'
import { LOCK } from '../domain/lock-names.ts'
import type { AssetSummary } from '../domain/rest-contracts.ts'
import {
    allocationProblem,
    awaitsReceipt,
    putAwayProblem,
    RECEIVING_STOCKROOM_TYPES,
    receivingProblem,
    type ReceivingLine,
} from '../domain/warehouse.ts'
import { LINE_STAGE, type StockroomType } from '../domain/vocabulary.ts'
import {
    fleetCandidate,
    identifyAnyAsset,
    identifyAsset,
    isFleetAsset,
    joinFleet,
    moveAndSave,
    moveAsset,
    newAsset,
    readStage,
    type AssetIdentified,
} from './assets.ts'
import { sourceOrderAgain, unitsOnLine } from './fulfilment.ts'
import { withLock } from './locks.ts'
import { loadNormalizationData, resolveModel } from './normalization.ts'
import { lineAwaitingRma, markReplacementReceived } from './oem-rma.ts'
import { takeUnitOffOrder } from './order-lines.ts'
import { purchaseOrderId } from './procurement.ts'
import { findById, num, refusal, str, warnRefused } from './records.ts'
import { receiveReturnedAsset } from './returns.ts'
import { withOrderLineLock } from './sourcing.ts'
import { openStagingTask } from './staging-tasks.ts'
import { changeStock, reserveAsset } from './stock.ts'
import { nextProviderTag } from './tags.ts'

/**
 * Depot work on a scanned unit (P1.5): receiving it, putting it away, picking it for an Order. Each gives the Asset as
 * it now stands, or why the scan did nothing, for the trigger that scanned (the warehouse app's REST API) to answer.
 */

/**
 * Why a scan did nothing. `reason` is the kind of refusal: the stockroom chosen is not one to use (`invalid`), no
 * Asset answers to the code (`unknown`), two Assets do or the Asset or its Order line is not in a state for it
 * (`conflict`), the
 * lifecycle or the platform refused what the scan would save (`refused`), or another scan or run holds a lock it needs
 * and scanning again will do (`busy`).
 */
export interface ScanRefusal {
    reason: 'invalid' | 'unknown' | 'conflict' | 'refused' | 'busy'
    why: string
}

/** What a scan came to: the Asset as it now stands, or why the scan did nothing. */
export type Scan = { asset: GlideRecord } | ScanRefusal

/** The unit a scan found or changed, as the warehouse API answers with it (domain/rest-contracts `AssetSummary`). */
export function assetSummary(asset: GlideRecord): AssetSummary {
    return {
        id: asset.getUniqueValue(),
        serial: str(asset, 'serial_number'),
        providerTag: str(asset, 'asset_tag'),
        model: asset.getDisplayValue('model'),
        pid: str(asset, `model.${OEM_PID_FIELD}`),
        stage: readStage(asset) ?? 'unknown',
        stockroom: asset.getDisplayValue('stockroom'),
        customer: asset.getDisplayValue('company'),
        orderLine: asset.getDisplayValue('x_daas_ham_order_line'),
    }
}

const SCAN_AGAIN: ScanRefusal = { reason: 'busy', why: 'Another scan is receiving this unit: scan again' }

const LINE_BUSY: ScanRefusal = { reason: 'busy', why: 'Its order line is being sourced, received or cancelled: scan again' }

const STOCK_BUSY: ScanRefusal = { reason: 'busy', why: 'This unit is being reserved or moved: scan again' }

const NOT_FOUND: ScanRefusal = { reason: 'unknown', why: 'No fleet asset with that serial or tag' }

const NOT_YOUR_STOCKROOM: ScanRefusal = { reason: 'invalid', why: 'Choose one of your stockrooms' }

/** A visible stockroom with no stockroom type is the Provider IT's: no NaaS unit is received or put away there. */
const NOT_NAAS_STOCKROOM = 'Choose a NaaS stockroom: this one has no stockroom type'

/** The stockroom, if the user may see it (the stockroom visibility rule applies to this lookup). */
function visibleStockroom(stockroomId: string): GlideRecord | null {
    return findById('alm_stockroom', stockroomId)
}

/** The stockroom's NaaS type, or null outside NaaS: a stockroom with no type is the Provider IT's (ADR 0016). */
function stockroomType(stockroom: GlideRecord): StockroomType | null {
    return naasStockroomType(str(stockroom, STOCKROOM_TYPE_FIELD))
}

/**
 * The fleet asset a scanned code names (platform/assets `identifyAsset`: serial, else Provider tag, else Customer tag),
 * or why it is not used: none carries it (`unknown`), or two do, as two Customers may share a Customer tag (`conflict`).
 */
function scannedAsset(code: string): Scan {
    return scanned(identifyAsset(code)) ?? NOT_FOUND
}

/** An identifier lookup as a scan reads it: the Asset, an ambiguous code refused, or null when none carries it. */
function scanned(identified: AssetIdentified): Scan | null {
    if (identified && 'ambiguous' in identified) return { reason: 'conflict', why: identified.ambiguous }
    return identified
}

/** The fleet asset a scanned code names (its serial, Provider tag or Customer tag), not the Provider IT's. */
export function lookUp(code: string): Scan {
    return scannedAsset(code)
}

/** A unit scanned for receipt: its code, and the PID (and manufacturer) scanned with it when no ASN announced it. */
export interface ScannedUnit {
    code: string
    pid?: string
    manufacturer?: string
}

/**
 * Receive a scanned unit into a stockroom: confirm an in-transit asset (ASN) or create one received without an ASN;
 * tag it and allocate it to an Order line waiting for this purchase.
 *
 * Every unit received is a fleet asset (ADR 0016). One the app created (an ASN row, a first scan) already is; one
 * Procurement created on order for a purchase order joins the fleet as it is received (domain/fleet `receiptProblem`).
 * Any other Asset outside the fleet is the Provider IT's and is refused, and its serial is never given a second Asset.
 *
 * Two scans of one unit (two devices, or a rescan while the first is still running) would both find it awaiting
 * receipt, each take a Provider tag and allocate it. So the receipt is made under a lock on the Asset, from a fresh
 * read; a scan that finds the lock held saves nothing and is told to scan again, and the rescan finds it received.
 * Two first scans of one unknown serial would both create its Asset, so that is done under a lock on the serial the
 * same way. A unit for a waiting Order line is also received, reserved and staged under the line's lock
 * (`receiveHolding`), and given to it only while the line, read again there, still waits and has room on an Order
 * neither cancelled nor rejected (`allocateHolding`). Taking a lock throws only when an insert is refused with no lock
 * row (platform/locks); that error escapes.
 */
export function receive(unit: ScannedUnit, stockroomId: string): Scan {
    const stockroom = visibleStockroom(stockroomId)
    if (!stockroom) return NOT_YOUR_STOCKROOM
    // A visible stockroom may be a customer site (asset managers see them all); units arrive only at the Provider's own.
    const type = stockroomType(stockroom)
    const wrongStockroom = type ? receivingProblem(type) : NOT_NAAS_STOCKROOM
    if (wrongStockroom) return { reason: 'invalid', why: wrongStockroom }

    // Arriving units (bought or returned) sit in none of the user's stockrooms yet, so the lookup goes past the stockroom
    // rule; only those stages are received below, never stock held elsewhere. It finds the Provider IT's Assets too, so
    // a serial IT holds is refused below rather than given a second Asset. A code two Assets carry is refused.
    let found = scanned(identifyAnyAsset(unit.code))
    if (!found) {
        if (!unit.pid) return { reason: 'unknown', why: 'Unknown serial: scan the PID too to receive without an ASN' }
        found = createReceivedAsset(unit.code, unit.pid, unit.manufacturer ?? '')
    }
    if ('reason' in found) return found
    const assetId = found.asset.getUniqueValue()
    // Not the stock lock (platform/stock) the allocation's reservation takes: a second take of a lock is refused.
    const receipt = withLock(LOCK.receiveAsset(assetId), (lock) => receiveHolding(lock, assetId, stockroomId))
    return receipt.ran ? receipt.value : SCAN_AGAIN
}

/** The receipt, made holding the Asset's `lock`: the stage is read again here, so only one scan receives the unit. */
function receiveHolding(lock: HeldLock, assetId: string, stockroomId: string): Scan {
    // Read again past the stockroom rule, as the scan's lookup was (see `receive`); the receipt's saves run the
    // lifecycle, billing and asset-CI rules.
    const asset = findById('alm_hardware', assetId, { beyondVisibility: true })
    if (!asset) return NOT_FOUND
    const stage = readStage(asset)
    // Outside the fleet, only a unit awaiting receipt is taken in, joining the fleet with this receipt's save; any
    // other is the Provider IT's (ADR 0016) and never reaches the returns process below.
    const outsideFleet = receiptProblem(fleetCandidate(asset), awaitsReceipt(stage))
    if (outsideFleet) return { reason: 'conflict', why: `Not received: ${outsideFleet}` }
    if (!isFleetAsset(asset)) joinFleet(asset)
    // A unit coming back from a Site is received or refused, staying pending return (or missing) for a rescan, and its
    // unsaved move is not shown. Any other unit is received as stock below.
    const returned = receiveReturnedAsset(asset, stockroomId)
    if (returned === 'received') return { asset }
    if (returned !== 'not_returning') return { reason: 'refused', why: `Not received: ${returned.refused}` }
    if (!awaitsReceipt(stage) || !moveAsset(asset, 'available').allowed) {
        // Found past the stockroom rule: a unit held in a stockroom the user cannot see is not described to them.
        if (!findById('alm_hardware', assetId)) return NOT_FOUND
        return { reason: 'conflict', why: `Not awaiting receipt (${stage ?? 'unknown stage'})` }
    }
    const tag = str(asset, 'asset_tag') || nextProviderTag()
    if (!tag) return { reason: 'busy', why: 'Other receipts are taking Provider tags: scan again' }
    asset.setValue('asset_tag', tag)
    asset.setValue('stockroom', stockroomId)
    const waiting = waitingLine(asset)
    if (!waiting) return saveReceipt(lock, asset) ?? { asset }
    // Saved, taken off order, reserved and staged under the line's lock, where sourcing counts the line's units and
    // on-order count (platform/sourcing) and a cancel of its Order releases them (platform/orders), so each sees all of
    // the receipt or none of it. A scan that cannot take it is told to scan again and saves nothing, so the rescan finds
    // the unit still awaiting receipt.
    const lineId = waiting.line.getUniqueValue()
    const underLine = withOrderLineLock(lineId, (lineLock) => saveReceipt(lock, asset) ?? allocateHolding(lineLock, asset, waiting))
    const received = underLine.ran ? underLine.value : LINE_BUSY
    if ('reason' in received) return received
    // Received as free stock: the line it was found for no longer waits for it (logged).
    if ('leftFree' in received) return { asset }
    if (!received.reserved) {
        // The receipt is saved; the reservation is not, so no Staging task opens. Off order and not allocated, the
        // line is a unit short, so its Order is sourced again: a sourcing run's stock pick, made outside the line's
        // lock, may have taken the unit between its save and its reservation. Read again for the caller: a run that
        // claimed the unit first has put it on its own line.
        sourceOrderAgain(str(waiting.line, 'order'))
        return { asset: findById('alm_hardware', assetId) ?? asset }
    }
    return { asset: received.reserved }
}

/** Save the receipt holding the Asset's `lock`: null once saved, or why not. */
function saveReceipt(lock: HeldLock, asset: GlideRecord): ScanRefusal | null {
    // A holder that outlasted the lock (ADR 0013) may overlap the next scan's receipt: it saves only while it holds it.
    const saved = lock.save(`${str(asset, 'serial_number')} received`, () => asset.update())
    if (saved === 'lock lost') return SCAN_AGAIN
    // A refused save leaves the unit in transit or on order for a rescan, and allocates nothing.
    return saved === 'refused' ? { reason: 'refused', why: `Not received: ${refusal(asset)}` } : null
}

/**
 * The Asset of an unknown serial scanned with its PID. The check that no Asset has the serial and the insert are made
 * under a lock on the serial, which an ASN row for the serial takes too (platform/imports), checking again there, so two
 * first scans of one unit, or a scan and its ASN row, create it once; a scan that finds the lock held is told to scan
 * again, and the rescan finds the Asset by serial.
 */
function createReceivedAsset(code: string, pid: string, manufacturer: string): Scan {
    const resolution = resolveModel({ manufacturer, model: pid }, loadNormalizationData())
    const modelId = resolution.modelId
    if (!modelId) return { reason: 'refused', why: `PID ${pid} does not map to a model` }
    const serial = normalizeSerial(code)
    const created = withLock(LOCK.receiveSerial(serial), (lock) => {
        // Any Asset the scanned code names, the Provider IT's too: the receipt refuses it rather than create a second one.
        return scanned(identifyAnyAsset(code)) ?? insertReceivedAsset(lock, modelId, serial)
    })
    return created.ran ? created.value : SCAN_AGAIN
}

/**
 * Insert the Asset holding the serial's `lock`: a holder that outlasted it (ADR 0013) leaves it to the next scan. Made
 * by `newAsset`, it is a fleet asset the Provider owns.
 */
function insertReceivedAsset(lock: HeldLock, modelId: string, serial: string): Scan {
    const asset = newAsset(modelId, 'on_order')
    asset.setValue('serial_number', serial)
    const saved = lock.save(`Asset ${serial} created`, () => asset.insert(), { check: 'check it exists once' })
    if (saved === 'lock lost') return SCAN_AGAIN
    if (saved === 'refused') return { reason: 'refused', why: `Not received: ${refusal(asset)}` }
    return { asset }
}

/** An Order line waiting for a received unit, with the OEM RMA the unit replaces under ('' for a purchase). */
interface WaitingLine {
    line: GlideRecord
    rmaId: string
}

/**
 * The Order line a received purchase (or OEM advance replacement, announced with its RMA number in the PO field) goes
 * straight to, or null.
 */
function waitingLine(asset: GlideRecord): WaitingLine | null {
    const poNumber = str(asset, 'po_number')
    if (!poNumber) return null
    const line = new GlideRecord('x_daas_ham_order_line')
    const viaRma = lineAwaitingRma(poNumber, str(asset, 'model'))
    if (viaRma) return line.get(viaRma.lineId) ? { line, rmaId: viaRma.rmaId } : null
    // A line lists every purchase order it raised, so units of an earlier one still find it.
    const poId = purchaseOrderId(poNumber)
    if (!poId) return null
    line.addQuery('purchase_orders', 'CONTAINS', poId)
    line.addQuery('model', str(asset, 'model'))
    line.addQuery('line_stage', LINE_STAGE.awaiting_stock)
    line.setLimit(1)
    line.query()
    return line.next() ? { line, rmaId: '' } : null
}

/** What a saved receipt came to on its line: reserved for it (null when that was not saved), or left free stock. */
type Allocation = { reserved: GlideRecord | null } | { leftFree: true }

/**
 * Give the saved receipt to the line waiting for it, holding the line's `lineLock`: a purchase comes off its on-order
 * count, an advance replacement marks its RMA received, and the unit is reserved for the line (null when it is not,
 * logged) and staged (`stageReserved`). The line was found before its lock was taken, so it is read again here, with
 * its Order: one another receipt or a sourcing run filled since, that moved on, or whose Order was cancelled or
 * rejected (domain/warehouse `allocationProblem`), is left as it is and the unit stays free stock (logged), its RMA, if
 * any, still open and named.
 */
function allocateHolding(lineLock: HeldLock, asset: GlideRecord, waiting: WaitingLine): Allocation {
    const line = findById('x_daas_ham_order_line', waiting.line.getUniqueValue())
    const problem = line ? allocationProblem(receivingLine(line)) : 'it no longer exists'
    if (!line || problem) {
        const unit = `${str(asset, 'serial_number')} left in stock, not given to ${str(waiting.line, 'number')}`
        // The RMA number came in the PO field (`waitingLine`).
        const rma = waiting.rmaId ? `; RMA ${str(asset, 'po_number')} left open, update it by hand` : ''
        gs.warn(`[x_daas_ham] Received ${unit}: ${problem ?? ''}${rma}`)
        return { leftFree: true }
    }
    if (waiting.rmaId) markReplacementReceived(waiting.rmaId, str(asset, 'serial_number'))
    else takeOffOrder(lineLock, line)
    // Received, the unit is free stock a sourcing run may pick too, so it is reserved the way sourcing claims stock:
    // under the Asset's stock lock, from a fresh read (platform/stock). Only one of them gets it.
    const reserved = reserveAsset(asset.getUniqueValue(), {
        orderLineId: line.getUniqueValue(),
        customerId: str(line, 'order.customer'),
        agreementId: str(line, 'order.agreement'),
    })
    if (!reserved) {
        const why = 'another run claimed it, or the save was refused'
        gs.warn(`[x_daas_ham] Received ${str(asset, 'serial_number')} not reserved for ${str(line, 'number')}: ${why}`)
        return { reserved: null }
    }
    return { reserved: stageReserved(lineLock, reserved, line) }
}

/** The line as `allocationProblem` judges it; its Assets are counted past the user's stockroom rule (ADR 0005). */
function receivingLine(line: GlideRecord): ReceivingLine {
    return {
        stage: str(line, 'line_stage') as ReceivingLine['stage'],
        orderStage: str(line, 'order.stage'),
        quantity: num(line, 'quantity'),
        allocated: unitsOnLine(line.getUniqueValue()),
    }
}

/** Take a received purchase off the line's on-order count, on the line read afresh holding its `lineLock`. */
function takeOffOrder(lineLock: HeldLock, line: GlideRecord): void {
    // Arrived, so no longer on order: re-sourcing covers quantity - allocated - on order and must not wait for it.
    // A refused count is logged to correct by hand; the unit still goes to the line, which would otherwise wait.
    const number = str(line, 'number')
    if (!takeUnitOffOrder(line)) return void warnRefused(line, `${number} keeps a unit on order`)
    // A holder that outlasted the lock (ADR 0013) may have counted beside a sourcing pass that took it over.
    lineLock.lostAfter(`${number} counted`, { check: 'check its On order count' })
}

/**
 * Stage a unit reserved on receipt for `line`, still holding its `lineLock`: a cancel of its Order, which takes the lock
 * (platform/orders `cancelOrder`), then finds the unit and its Staging task, or neither. The Asset as it now stands,
 * for the caller.
 */
function stageReserved(lineLock: HeldLock, reserved: GlideRecord, line: GlideRecord): GlideRecord {
    // Checked after each write: a holder that outlasted the lock (ADR 0013) may overlap a cancel that took it over, so
    // it stages no further.
    const lost = (what: string): boolean =>
        lineLock.lostAfter(`${str(line, 'number')}: ${str(reserved, 'serial_number')} ${what}`, { check: 'check it is still on the line' })
    // Without its Staging task the Asset stays reserved for the line, not staging with no task to finish. A refused
    // move (logged) leaves it reserved too, with the unsaved move on the record, so it is read again for the caller.
    if (lost('reserved') || !openStagingTask(reserved, line.getUniqueValue()) || lost('given a Staging task')) return reserved
    if (moveAndSave(reserved, 'staging', 'receiving')) lost('moved into staging')
    else reserved.get(reserved.getUniqueValue())
    return reserved
}

/**
 * Record the stockroom an in-stock asset now sits in, when it is free to move there. A sourcing run or the spare-pool
 * top-up may claim free stock between the check and the save, and a claimed unit stays where its line expects it, so
 * the put-away is made under the lock claims take, from a fresh read (platform/stock `changeStock`). A scan that cannot
 * take it is told to scan again and saves nothing.
 */
export function putAway(code: string, stockroomId: string): Scan {
    const stockroom = visibleStockroom(stockroomId)
    if (!stockroom) return NOT_YOUR_STOCKROOM
    const type = stockroomType(stockroom)
    if (!type) return { reason: 'invalid', why: NOT_NAAS_STOCKROOM }
    // A fleet asset only: the Provider IT's are not found.
    const found = scannedAsset(code)
    if ('reason' in found) return found
    const change = changeStock(found.asset.getUniqueValue(), 'put away', (asset, lock) =>
        asset ? putAwayHolding(lock, asset, stockroom, type) : NOT_FOUND,
    )
    return change.ran ? change.value : STOCK_BUSY
}

/**
 * The put-away into `stockroom`, a NaaS stockroom of `type`, made holding the Asset's stock `lock` on its fresh read:
 * the Asset once saved, or why not.
 */
function putAwayHolding(lock: HeldLock, asset: GlideRecord, stockroom: GlideRecord, type: StockroomType): Scan {
    const problem = putAwayProblem(readStage(asset), type)
    if (problem) return { reason: 'conflict', why: problem }
    asset.setValue('stockroom', stockroom.getUniqueValue())
    // A holder that outlasted the lock (ADR 0013) may overlap a claim: it saves only while it holds it.
    const saved = lock.save(`${str(asset, 'serial_number')} put away`, () => asset.update())
    if (saved === 'lock lost') return STOCK_BUSY
    if (saved === 'refused') return { reason: 'refused', why: `Not put away: ${refusal(asset)}` }
    return { asset }
}

/** Confirm a scanned fleet asset is a staged asset of the Order numbered `orderNumber`. */
export function pick(code: string, orderNumber: string): Scan {
    const found = scannedAsset(code)
    if ('reason' in found) return found
    const asset = found.asset
    const ownOrder = str(asset, 'x_daas_ham_order_line.order.number')
    if (ownOrder !== orderNumber) {
        return { reason: 'conflict', why: ownOrder ? `Belongs to ${ownOrder}` : 'Not allocated to an order' }
    }
    if (readStage(asset) !== 'staged') return { reason: 'conflict', why: `Not ready to ship (${readStage(asset)})` }
    return { asset }
}

/** The stockrooms the user may receive into (visibility rules apply), by name. */
export function receivingStockrooms(): Array<{ id: string; name: string }> {
    const stockroom = new GlideRecord('alm_stockroom')
    stockroom.addQuery(STOCKROOM_TYPE_FIELD, 'IN', RECEIVING_STOCKROOM_TYPES.join(','))
    stockroom.orderBy('name')
    stockroom.setLimit(500)
    stockroom.query()
    const stockrooms: Array<{ id: string; name: string }> = []
    while (stockroom.next()) stockrooms.push({ id: stockroom.getUniqueValue(), name: str(stockroom, 'name') })
    return stockrooms
}
