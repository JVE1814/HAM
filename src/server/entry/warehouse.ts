import { GlideRecord, gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { normalizeSerial } from '../domain/serials.ts'
import { naasStockroomType, receiptProblem, STOCKROOM_TYPE_FIELD } from '../domain/fleet.ts'
import type { HeldLock } from '../domain/job-lock.ts'
import { LOCK } from '../domain/lock-names.ts'
import type { AssetSummary, Stockroom, StockroomList } from '../domain/rest-contracts.ts'
import { ROLE } from '../domain/visibility.ts'
import {
    allocationProblem,
    awaitsReceipt,
    putAwayProblem,
    RECEIVING_STOCKROOM_TYPES,
    receivingProblem,
    type ReceivingLine,
} from '../domain/warehouse.ts'
import type { StockroomType } from '../domain/vocabulary.ts'
import {
    findAnyAsset,
    findAssetByIdentifier,
    fleetCandidate,
    isFleetAsset,
    joinFleet,
    moveAsset,
    newAsset,
    readStage,
} from '../platform/assets.ts'
import { sourceOrderAgain, unitsOnLine } from '../platform/fulfilment.ts'
import { withLock } from '../platform/locks.ts'
import { loadNormalizationData, resolveModel } from '../platform/normalization.ts'
import { lineAwaitingRma, markReplacementReceived } from '../platform/oem-rma.ts'
import { purchaseOrderId } from '../platform/procurement.ts'
import { findById, num, refusal, str, warnRefused } from '../platform/records.ts'
import { reply } from '../platform/rest-api.ts'
import { withOrderLineLock } from '../platform/sourcing.ts'
import { startStaging } from '../platform/staging-tasks.ts'
import { changeStock, reserveAsset } from '../platform/stock.ts'
import { nextProviderTag } from '../platform/tags.ts'
import { receiveReturnedAsset } from './returns.ts'

/** Warehouse scanning API used by the warehouse React app (P1.5). */

function summarise(asset: GlideRecord): AssetSummary {
    return {
        id: asset.getUniqueValue(),
        serial: str(asset, 'serial_number'),
        providerTag: str(asset, 'asset_tag'),
        model: asset.getDisplayValue('model'),
        pid: str(asset, 'model.x_daas_ham_oem_pid'),
        stage: readStage(asset) ?? 'unknown',
        stockroom: asset.getDisplayValue('stockroom'),
        customer: asset.getDisplayValue('company'),
        orderLine: asset.getDisplayValue('x_daas_ham_order_line'),
    }
}

/** Receive, put away, pick and the stockroom list are depot work: inventory techs (asset managers and admins too). */
function allowed(response: RESTAPIResponse): boolean {
    if (gs.hasRole(ROLE.inventoryTech)) return true
    reply(response, 403, { error: 'Requires the inventory tech role' })
    return false
}

/** A look-up only reads the Asset, so field techs, who read every Asset, may look up too. */
function allowedLookup(response: RESTAPIResponse): boolean {
    if (gs.hasRole(ROLE.inventoryTech) || gs.hasRole(ROLE.fieldTech)) return true
    reply(response, 403, { error: 'Requires the inventory tech or field tech role' })
    return false
}

/** The stockroom, if the user may see it (the stockroom visibility rule applies to this lookup). */
function visibleStockroom(stockroomId: string | undefined): GlideRecord | null {
    return findById('alm_stockroom', stockroomId ?? '')
}

/** The stockroom's NaaS type, or null outside NaaS: a stockroom with no type is the Provider IT's (ADR 0016). */
function stockroomType(stockroom: GlideRecord): StockroomType | null {
    return naasStockroomType(str(stockroom, STOCKROOM_TYPE_FIELD))
}

/** A visible stockroom with no stockroom type is the Provider IT's: no NaaS unit is received or put away there. */
const NOT_NAAS_STOCKROOM = 'Choose a NaaS stockroom: this one has no stockroom type'

function body(request: RESTAPIRequest): Record<string, string> {
    const data = request.body.data as Record<string, unknown> | null
    return Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [k, String(v ?? '').trim()]))
}

/** GET /assets/{code}: look a fleet asset up by serial, Provider tag or Customer tag (not the Provider IT's). */
export function lookupAsset(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowedLookup(response)) return
    const asset = findAssetByIdentifier(String(request.pathParams.code ?? ''))
    if (!asset) return refuse(response, NOT_FOUND)
    reply(response, 200, summarise(asset))
}

/**
 * POST /receive { code, stockroom, pid?, manufacturer? }: confirm an in-transit asset (ASN) or create
 * one received without an ASN; tag it and allocate it to an Order line waiting for this purchase.
 *
 * Every unit received is a fleet asset (ADR 0016). One the app created (an ASN row, a first scan) already is; one
 * Procurement created on order for a purchase order joins the fleet as it is received (domain/fleet `receiptProblem`).
 * Any other Asset outside the fleet is the Provider IT's and is refused, and its serial is never given a second Asset.
 *
 * Two scans of one unit (two devices, or a rescan while the first is still running) would both find it awaiting
 * receipt, each take a Provider tag and allocate it. So the receipt is made under a lock on the Asset, from a fresh
 * read; a scan that finds the lock held saves nothing and is told to scan again, and the rescan finds it received.
 * Two first scans of one unknown serial would both create its Asset, so that is done under a lock on the serial the
 * same way. A unit for a waiting Order line is also received under the line's lock (`receiveHolding`), and given to it
 * only while the line, read again there, still waits and has room (`allocateHolding`). Taking a lock throws only when
 * an insert is refused with no lock row (platform/locks); that error escapes.
 */
export function receiveAsset(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const input = body(request)
    if (!input.code || !input.stockroom) return reply(response, 400, { error: 'code and stockroom are required' })

    const stockroom = visibleStockroom(input.stockroom)
    if (!stockroom) return reply(response, 400, { error: 'Choose one of your stockrooms' })
    // A visible stockroom may be a customer site (asset managers see them all); units arrive only at the Provider's own.
    const type = stockroomType(stockroom)
    const wrongStockroom = type ? receivingProblem(type) : NOT_NAAS_STOCKROOM
    if (wrongStockroom) return reply(response, 400, { error: wrongStockroom })

    // Arriving units (bought or returned) sit in none of the user's stockrooms yet, so the lookup goes past the stockroom
    // rule; only those stages are received below, never stock held elsewhere. It finds the Provider IT's Assets too, so
    // a serial IT holds is refused below rather than given a second Asset.
    let asset = findAnyAsset(input.code, 'identifier')
    if (!asset) {
        if (!input.pid) return reply(response, 404, { error: 'Unknown serial: scan the PID too to receive without an ASN' })
        const created = createReceivedAsset(input)
        if ('error' in created) return refuse(response, created)
        asset = created.asset
    }
    const assetId = asset.getUniqueValue()
    // Not the stock lock (platform/stock) the allocation's reservation takes: a second take of a lock is refused.
    const receipt = withLock(LOCK.receiveAsset(assetId), (lock) => {
        receiveHolding(lock, response, assetId, input.stockroom)
    })
    if (!receipt.ran) refuse(response, SCAN_AGAIN)
}

/** Why a receipt saved nothing: the HTTP status and error it answers with. */
interface Unsaved {
    status: number
    error: string
}

const SCAN_AGAIN: Unsaved = { status: 503, error: 'Another scan is receiving this unit: scan again' }

const LINE_BUSY: Unsaved = { status: 503, error: 'Its order line is being sourced or received: scan again' }

const STOCK_BUSY: Unsaved = { status: 503, error: 'This unit is being reserved or moved: scan again' }

const NOT_FOUND: Unsaved = { status: 404, error: 'No fleet asset with that serial or tag' }

function refuse(response: RESTAPIResponse, unsaved: Unsaved): void {
    reply(response, unsaved.status, { error: unsaved.error })
}

/** The receipt, made holding the Asset's `lock`: the stage is read again here, so only one scan receives the unit. */
function receiveHolding(lock: HeldLock, response: RESTAPIResponse, assetId: string, stockroomId: string): void {
    // Read again past the stockroom rule, as the scan's lookup was (see `receiveAsset`); the receipt's saves run the
    // lifecycle, billing and asset-CI rules.
    const asset = findById('alm_hardware', assetId, { beyondVisibility: true })
    if (!asset) return refuse(response, NOT_FOUND)
    const stage = readStage(asset)
    // Outside the fleet, only a unit awaiting receipt is taken in, joining the fleet with this receipt's save; any
    // other is the Provider IT's (ADR 0016) and never reaches the returns process below.
    const outsideFleet = receiptProblem(fleetCandidate(asset), awaitsReceipt(stage))
    if (outsideFleet) return reply(response, 409, { error: `Not received: ${outsideFleet}` })
    if (!isFleetAsset(asset)) joinFleet(asset)
    // A unit coming back from a Site is received ('') or refused, staying pending return (or missing) for a rescan, and
    // its unsaved move is not shown. Any other unit (null) is received as stock below.
    const returnRefusal = receiveReturnedAsset(asset, stockroomId)
    if (returnRefusal) return reply(response, 422, { error: `Not received: ${returnRefusal}` })
    if (returnRefusal === '') return reply(response, 200, summarise(asset))
    if (!awaitsReceipt(stage) || !moveAsset(asset, 'available').allowed) {
        return reply(response, 409, { error: `Not awaiting receipt (${stage ?? 'unknown stage'})` })
    }
    const tag = str(asset, 'asset_tag') || nextProviderTag()
    if (!tag) return reply(response, 503, { error: 'Other receipts are taking Provider tags: scan again' })
    asset.setValue('asset_tag', tag)
    asset.setValue('stockroom', stockroomId)
    const waiting = waitingLine(asset)
    if (!waiting) {
        const unsaved = saveReceipt(lock, asset)
        return unsaved ? refuse(response, unsaved) : reply(response, 200, summarise(asset))
    }
    // Saved, taken off order and reserved under the line's lock, where sourcing counts the line's units and on-order
    // count (platform/sourcing), so that count sees all of the receipt or none of it. A scan that cannot take it is told to
    // scan again and saves nothing, so the rescan finds the unit still awaiting receipt.
    const lineId = waiting.line.getUniqueValue()
    const underLine = withOrderLineLock(lineId, (lineLock) => saveReceipt(lock, asset) ?? allocateHolding(lineLock, asset, waiting))
    const received = underLine.ran ? underLine.value : LINE_BUSY
    if ('error' in received) return refuse(response, received)
    // Received as free stock: the line it was found for no longer waits for it (logged).
    if ('leftFree' in received) return reply(response, 200, summarise(asset))
    if (!received.reserved) {
        // The receipt is saved; the reservation is not, so no Staging task opens. Off order and not allocated, the
        // line is a unit short, so its Order is sourced again: a sourcing run's stock pick, made outside the line's
        // lock, may have taken the unit between its save and its reservation. Read again for the reply: a run that
        // claimed the unit first has put it on its own line.
        sourceOrderAgain(str(waiting.line, 'order'))
        return reply(response, 200, summarise(findById('alm_hardware', assetId) ?? asset))
    }
    reply(response, 200, summarise(stageReserved(received.reserved, lineId)))
}

/** Save the receipt holding the Asset's `lock`: null once saved, or why not. */
function saveReceipt(lock: HeldLock, asset: GlideRecord): Unsaved | null {
    // A holder that outlasted the lock (ADR 0013) may overlap the next scan's receipt: it saves only while it holds it.
    const saved = lock.save(`${str(asset, 'serial_number')} received`, () => asset.update())
    if (saved === 'lock lost') return SCAN_AGAIN
    // A refused save leaves the unit in transit or on order for a rescan, and allocates nothing.
    return saved === 'refused' ? { status: 422, error: `Not received: ${refusal(asset)}` } : null
}

/**
 * The Asset of an unknown serial scanned with its PID. The check that no Asset has the serial and the insert are made
 * under a lock on the serial, which an ASN row for the serial takes too (platform/imports), checking again there, so two
 * first scans of one unit, or a scan and its ASN row, create it once; a scan that finds the lock held is told to scan
 * again, and the rescan finds the Asset by serial.
 */
function createReceivedAsset(input: Record<string, string>): { asset: GlideRecord } | Unsaved {
    const resolution = resolveModel({ manufacturer: input.manufacturer ?? '', model: input.pid }, loadNormalizationData())
    const modelId = resolution.modelId
    if (!modelId) return { status: 422, error: `PID ${input.pid} does not map to a model` }
    const serial = normalizeSerial(input.code)
    const created = withLock(LOCK.receiveSerial(serial), (lock) => {
        // Any Asset the scanned code names, the Provider IT's too: the receipt refuses it rather than create a second one.
        const found = findAnyAsset(input.code, 'identifier')
        return found ? { asset: found } : insertReceivedAsset(lock, modelId, serial)
    })
    return created.ran ? created.value : SCAN_AGAIN
}

/**
 * Insert the Asset holding the serial's `lock`: a holder that outlasted it (ADR 0013) leaves it to the next scan. Made
 * by `newAsset`, it is a fleet asset the Provider owns.
 */
function insertReceivedAsset(lock: HeldLock, modelId: string, serial: string): { asset: GlideRecord } | Unsaved {
    const asset = newAsset(modelId, 'on_order')
    asset.setValue('serial_number', serial)
    const saved = lock.save(`Asset ${serial} created`, () => asset.insert(), { check: 'check it exists once' })
    if (saved === 'lock lost') return SCAN_AGAIN
    if (saved === 'refused') return { status: 422, error: `Not received: ${refusal(asset)}` }
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
    line.addQuery('line_stage', 'awaiting_stock')
    line.setLimit(1)
    line.query()
    return line.next() ? { line, rmaId: '' } : null
}

/** What a saved receipt came to on its line: reserved for it (null when that was not saved), or left free stock. */
type Allocation = { reserved: GlideRecord | null } | { leftFree: true }

/**
 * Give the saved receipt to the line waiting for it, holding the line's `lineLock`: a purchase comes off its on-order
 * count, an advance replacement marks its RMA received, and the unit is reserved for the line (null when it is not,
 * logged). The line was found before its lock was taken, so it is read again here: one another receipt or a sourcing
 * run filled since, or that moved on (domain/warehouse `allocationProblem`), is left as it is and the unit stays free
 * stock (logged), its RMA, if any, still open.
 */
function allocateHolding(lineLock: HeldLock, asset: GlideRecord, waiting: WaitingLine): Allocation {
    const line = findById('x_daas_ham_order_line', waiting.line.getUniqueValue())
    const problem = line ? allocationProblem(receivingLine(line)) : 'it no longer exists'
    if (!line || problem) {
        const unit = `${str(asset, 'serial_number')} left in stock, not given to ${str(waiting.line, 'number')}`
        gs.warn(`[x_daas_ham] Received ${unit}: ${problem ?? ''}`)
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
    }
    return { reserved }
}

/** The line as `allocationProblem` judges it; its Assets are counted past the user's stockroom rule (ADR 0005). */
function receivingLine(line: GlideRecord): ReceivingLine {
    return {
        stage: str(line, 'line_stage') as ReceivingLine['stage'],
        quantity: num(line, 'quantity'),
        allocated: unitsOnLine(line.getUniqueValue()),
    }
}

/** Take a received purchase off the line's on-order count, on the line read afresh holding its `lineLock`. */
function takeOffOrder(lineLock: HeldLock, line: GlideRecord): void {
    // Arrived, so no longer on order: re-sourcing covers quantity - allocated - on order and must not wait for it.
    // A refused count is logged to correct by hand; the unit still goes to the line, which would otherwise wait.
    line.setValue('quantity_to_purchase', Math.max(0, num(line, 'quantity_to_purchase') - 1))
    const number = str(line, 'number')
    if (!line.update()) return void warnRefused(line, `${number} keeps a unit on order`)
    // A holder that outlasted the lock (ADR 0013) may have counted beside a sourcing pass that took it over.
    lineLock.lostAfter(`${number} counted`, { check: 'check its On order count' })
}

/** Stage a unit reserved on receipt for `lineId`; the Asset as it now stands, for the reply. */
function stageReserved(reserved: GlideRecord, lineId: string): GlideRecord {
    // Without its Staging task the Asset stays reserved for the line. A refused move (logged) leaves it reserved too,
    // with the unsaved move on the record, so it is read again for the reply.
    if (startStaging(reserved, lineId, 'receiving') === 'not_moved') reserved.get(reserved.getUniqueValue())
    return reserved
}

/**
 * POST /putaway { code, stockroom }: record the stockroom an in-stock asset now sits in, when it is free to move there.
 * A sourcing run or the spare-pool top-up may claim free stock between the check and the save, and a claimed unit stays
 * where its line expects it, so the put-away is made under the lock claims take, from a fresh read (platform/stock
 * `changeStock`). A scan that cannot take it is told to scan again and saves nothing.
 */
export function putAwayAsset(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const input = body(request)
    const stockroom = visibleStockroom(input.stockroom)
    if (!stockroom) return reply(response, 400, { error: 'Choose one of your stockrooms' })
    const type = stockroomType(stockroom)
    if (!type) return reply(response, 400, { error: NOT_NAAS_STOCKROOM })
    // A fleet asset only: the Provider IT's are not found.
    const found = findAssetByIdentifier(input.code ?? '')
    if (!found) return refuse(response, NOT_FOUND)
    const change = changeStock(found.getUniqueValue(), 'put away', (asset, lock) =>
        asset ? putAwayHolding(lock, asset, stockroom, type) : NOT_FOUND,
    )
    const putAway = change.ran ? change.value : STOCK_BUSY
    if ('error' in putAway) return refuse(response, putAway)
    reply(response, 200, summarise(putAway.asset))
}

/**
 * The put-away into `stockroom`, a NaaS stockroom of `type`, made holding the Asset's stock `lock` on its fresh read:
 * the Asset once saved, or why not.
 */
function putAwayHolding(
    lock: HeldLock,
    asset: GlideRecord,
    stockroom: GlideRecord,
    type: StockroomType,
): Unsaved | { asset: GlideRecord } {
    const problem = putAwayProblem(readStage(asset), type)
    if (problem) return { status: 409, error: problem }
    asset.setValue('stockroom', stockroom.getUniqueValue())
    // A holder that outlasted the lock (ADR 0013) may overlap a claim: it saves only while it holds it.
    const saved = lock.save(`${str(asset, 'serial_number')} put away`, () => asset.update())
    if (saved === 'lock lost') return STOCK_BUSY
    if (saved === 'refused') return { status: 422, error: `Not put away: ${refusal(asset)}` }
    return { asset }
}

/** POST /pick { code, order }: confirm a scanned fleet asset is a staged asset of this Order. */
export function pickAsset(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const input = body(request)
    const asset = findAssetByIdentifier(input.code ?? '')
    if (!asset) return refuse(response, NOT_FOUND)
    const orderNumber = str(asset, 'x_daas_ham_order_line.order.number')
    if (orderNumber !== input.order) {
        return reply(response, 409, { error: orderNumber ? `Belongs to ${orderNumber}` : 'Not allocated to an order' })
    }
    if (readStage(asset) !== 'staged') return reply(response, 409, { error: `Not ready to ship (${readStage(asset)})` })
    reply(response, 200, summarise(asset))
}

/** GET /stockrooms: stockrooms the user may receive into (visibility rules apply). */
export function listStockrooms(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const stockroom = new GlideRecord('alm_stockroom')
    stockroom.addQuery('x_daas_ham_stockroom_type', 'IN', RECEIVING_STOCKROOM_TYPES.join(','))
    stockroom.orderBy('name')
    stockroom.setLimit(500)
    stockroom.query()
    const stockrooms: Stockroom[] = []
    while (stockroom.next()) stockrooms.push({ id: stockroom.getUniqueValue(), name: str(stockroom, 'name') })
    reply(response, 200, { stockrooms } satisfies StockroomList)
}
