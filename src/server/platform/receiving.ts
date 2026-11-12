import { GlideRecord } from '@servicenow/glide'
import { asnRowProblem } from '../domain/asn.ts'
import { normalizeSerial } from '../domain/serials.ts'
import { naasStockroomType, OEM_PID_FIELD, providerStockroomCondition, receiptProblem, STOCKROOM_TYPE_FIELD } from '../domain/fleet.ts'
import { LOCK_TRIES, type HeldLock, type LockAttempt } from '../domain/job-lock.ts'
import type { Stage } from '../domain/lifecycle.ts'
import { LOCK } from '../domain/lock-names.ts'
import type { AssetSummary } from '../domain/rest-contracts.ts'
import { allocationProblem, awaitsReceipt, pickProblem, putAwayProblem, receivingProblem, type ReceivingLine } from '../domain/warehouse.ts'
import { DEFAULT_STAGING_SOURCE } from '../domain/staging.ts'
import { LINE_STAGE, type StagingSource, type StockroomType } from '../domain/vocabulary.ts'
import { findAnyAssetBySerial, identifyAnyAsset, identifyAsset, type AssetIdentified } from './asset-identifiers.ts'
import { fleetCandidate, isFleetAsset, joinFleet, moveAsset, newAsset, readStage } from './assets.ts'
import { unitsOnLine } from './fulfilment.ts'
import { attemptLock, whyNotRun, withLock } from './locks.ts'
import { loadNormalizationData, recordNormalizationException, resolveModel } from './normalization.ts'
import { lineAwaitingRma, markReplacementReceived } from './oem-rma.ts'
import { lineOpenness, takeUnitOffOrder, withOrderLineLock } from './order-lines.ts'
import { purchaseOrderId } from './procurement.ts'
import { choice, findById, num, refusal, rowError, str, warnRefused, type RowOutcome } from './records.ts'
import { receiveReturnedAsset } from './returns.ts'
import { queueSourcing } from './sourcing-requests.ts'
import { startStaging } from './staging-tasks.ts'
import { changeStock, reserveAsset } from './stock.ts'
import { nextProviderTag } from './tags.ts'
import { log } from './log.ts'

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

export type Scan = { asset: GlideRecord } | ScanRefusal

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

/**
 * The fleet asset a scanned code names (platform/asset-identifiers `identifyAsset`: serial, else Provider tag, else Customer tag),
 * not the Provider IT's, or why it is not used: none carries it (`unknown`), or two do, as two Customers may share a
 * Customer tag (`conflict`).
 */
export function lookUp(code: string): Scan {
    return scanned(identifyAsset(code)) ?? NOT_FOUND
}

function scanned(identified: AssetIdentified): Scan | null {
    if (identified && 'ambiguous' in identified) return { reason: 'conflict', why: identified.ambiguous }
    return identified
}

/** A unit scanned for receipt: its code, and the PID scanned with it when no ASN announced it. */
export interface ScannedUnit {
    code: string
    pid?: string
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
    const stockroom = findById('alm_stockroom', stockroomId)
    if (!stockroom) return NOT_YOUR_STOCKROOM
    // A visible stockroom may be a customer site (asset managers see them all); units arrive only at the Provider's own.
    const type = naasStockroomType(str(stockroom, STOCKROOM_TYPE_FIELD))
    const wrongStockroom = type ? receivingProblem(type) : NOT_NAAS_STOCKROOM
    if (wrongStockroom) return { reason: 'invalid', why: wrongStockroom }

    // Arriving units (bought or returned) sit in none of the user's stockrooms yet, so the lookup goes past the stockroom
    // rule; only those stages are received below, never stock held elsewhere. It finds the Provider IT's Assets too, so
    // a serial IT holds is refused below rather than given a second Asset. A code two Assets carry is refused.
    let found = scanned(identifyAnyAsset(unit.code))
    if (!found) {
        if (!unit.pid) return { reason: 'unknown', why: 'Unknown serial: scan the PID too to receive without an ASN' }
        found = firstScanAsset(unit.code, unit.pid)
    }
    if ('reason' in found) return found
    const assetId = found.asset.getUniqueValue()
    // Not the stock lock (platform/stock) the allocation's reservation takes: a second take of a lock is refused.
    const receipt = withLock(LOCK.receiveAsset(assetId), (lock) => receiveHolding(lock, assetId, stockroomId))
    return receipt.ran ? receipt.value : SCAN_AGAIN
}

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
    if ('leftFree' in received) return { asset }
    if (!received.reserved) {
        // The receipt is saved; the reservation is not, so no Staging task opens. Off order and not allocated, the
        // line is a unit short, so its Order is sourced again: a sourcing run's stock pick, made outside the line's
        // lock, may have taken the unit between its save and its reservation. Read again for the caller: a run that
        // claimed the unit first has put it on its own line.
        queueSourcing(str(waiting.line, 'order'))
        return { asset: findById('alm_hardware', assetId) ?? asset }
    }
    return { asset: received.reserved }
}

function saveReceipt(lock: HeldLock, asset: GlideRecord): ScanRefusal | null {
    // A holder that outlasted the lock (ADR 0013) may overlap the next scan's receipt: it saves only while it holds it.
    const saved = lock.save(`${str(asset, 'serial_number')} received`, () => asset.update())
    if (saved === 'lock lost') return SCAN_AGAIN
    // A refused save leaves the unit in transit or on order for a rescan, and allocates nothing.
    return saved === 'refused' ? { reason: 'refused', why: `Not received: ${refusal(asset)}` } : null
}

type SerialAsset<E> = { created: GlideRecord } | { existing: E } | { refused: string } | 'lock lost'

/**
 * Create the Asset of a received `serial` in `stage` with `values`, unless `existing` answers that it has one. Every
 * receipt that creates an Asset from a serial (a first scan without an ASN, an ASN row) does it here: under the
 * serial's lock, checking `existing` again holding it, so two of them create it once. A holder that outlasted the lock
 * (ADR 0013) inserts nothing ('lock lost'), and one that lost it during the insert is logged. Made by `newAsset`, the
 * Asset is a fleet asset the Provider owns. A lock held through every one of `tries`, or not taken, is `attemptLock`'s.
 */
function createReceivedAsset<E>(
    serial: string,
    modelId: string,
    stage: Stage,
    values: Readonly<Record<string, string>>,
    existing: () => E | null,
    tries: number,
): LockAttempt<SerialAsset<E>> {
    return attemptLock(
        LOCK.receiveSerial(serial),
        (lock): SerialAsset<E> => {
            const found = existing()
            if (found !== null) return { existing: found }
            const asset = newAsset(modelId, stage)
            asset.setValue('serial_number', serial)
            for (const [field, value] of Object.entries(values)) asset.setValue(field, value)
            const saved = lock.save(`Asset ${serial} created`, () => asset.insert(), { check: 'check it exists once' })
            if (saved === 'lock lost') return 'lock lost'
            return saved === 'refused' ? { refused: refusal(asset) } : { created: asset }
        },
        tries,
    )
}

/**
 * The Asset of an unknown serial scanned with its PID (`createReceivedAsset`). A scan that finds the serial's lock held
 * is told to scan again, and the rescan finds the Asset by serial.
 */
function firstScanAsset(code: string, pid: string): Scan {
    const resolution = resolveModel({ manufacturer: '', model: pid }, loadNormalizationData())
    if (!resolution.matched) return { reason: 'refused', why: `PID ${pid} does not map to a model` }
    const { modelId } = resolution
    // Any Asset the scanned code names, the Provider IT's too: the receipt refuses it rather than create a second one.
    const attempt = createReceivedAsset(normalizeSerial(code), modelId, 'on_order', {}, () => scanned(identifyAnyAsset(code)), 1)
    if (!attempt.ran && !attempt.held) throw attempt.error
    if (!attempt.ran || attempt.value === 'lock lost') return SCAN_AGAIN
    const made = attempt.value
    if ('existing' in made) return made.existing
    if ('refused' in made) return { reason: 'refused', why: `Not received: ${made.refused}` }
    return { asset: made.created }
}

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
        const rma = waiting.rmaId ? `; RMA ${str(asset, 'po_number')} left open, update it by hand` : ''
        log.warn(`Received ${unit}: ${problem ?? ''}${rma}`)
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
        log.warn(`Received ${str(asset, 'serial_number')} not reserved for ${str(line, 'number')}: ${why}`)
        return { reserved: null }
    }
    return { reserved: stageReserved(lineLock, reserved, line) }
}

/** The line as `allocationProblem` judges it; its Assets are counted past the user's stockroom rule (ADR 0005). */
function receivingLine(line: GlideRecord): ReceivingLine {
    return {
        ...lineOpenness(line),
        quantity: num(line, 'quantity'),
        allocated: unitsOnLine(line.getUniqueValue()),
    }
}

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
    if (lost('reserved')) return reserved
    // A refused move leaves its unsaved values on the record.
    if (startStaging(reserved, line.getUniqueValue(), 'receiving', lost) === 'not_moved') reserved.get(reserved.getUniqueValue())
    return reserved
}

/**
 * Record the stockroom an in-stock asset now sits in, when it is free to move there. A sourcing run or the spare-pool
 * top-up may claim free stock between the check and the save, and a claimed unit stays where its line expects it, so
 * the put-away is made under the lock claims take, from a fresh read (platform/stock `changeStock`). A scan that cannot
 * take it is told to scan again and saves nothing.
 */
export function putAway(code: string, stockroomId: string): Scan {
    const stockroom = findById('alm_stockroom', stockroomId)
    if (!stockroom) return NOT_YOUR_STOCKROOM
    const type = naasStockroomType(str(stockroom, STOCKROOM_TYPE_FIELD))
    if (!type) return { reason: 'invalid', why: NOT_NAAS_STOCKROOM }
    const found = lookUp(code)
    if ('reason' in found) return found
    const change = changeStock(found.asset.getUniqueValue(), 'put away', (asset, lock) =>
        asset ? putAwayHolding(lock, asset, stockroom, type) : NOT_FOUND,
    )
    return change.ran ? change.value : STOCK_BUSY
}

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

export function pick(code: string, orderNumber: string): Scan {
    const found = lookUp(code)
    if ('reason' in found) return found
    const asset = found.asset
    const problem = pickProblem(str(asset, 'x_daas_ham_order_line.order.number'), orderNumber, readStage(asset))
    return problem ? { reason: 'conflict', why: problem } : { asset }
}

export function receivingStockrooms(): Array<{ id: string; name: string }> {
    const stockroom = new GlideRecord('alm_stockroom')
    stockroom.addEncodedQuery(providerStockroomCondition())
    stockroom.orderBy('name')
    stockroom.setLimit(500)
    stockroom.query()
    const stockrooms: Array<{ id: string; name: string }> = []
    while (stockroom.next()) stockrooms.push({ id: stockroom.getUniqueValue(), name: str(stockroom, 'name') })
    return stockrooms
}

/**
 * Import an ASN row: create its in-transit Asset (ASN = scan-to-confirm receiving; `createReceivedAsset`), with what
 * the row says of it. A row that finds the serial's lock held through every try (a holder keeps it for one check and
 * one insert), or whose lock cannot be taken, is marked error with why, to load again; loaded again once a scan has
 * created the Asset, it is refused as a serial that already exists.
 */
export function importAsnRow(row: GlideRecord): RowOutcome {
    const serial = normalizeSerial(str(row, 'serial'))
    // Most refused rows (a missing field, a serial known long since) are refused here, without the lock.
    const problem = checkAsnRow(row, serial)
    if (problem) return rowError(problem)

    const raw = { manufacturer: str(row, 'manufacturer'), model: str(row, 'pid') }
    const resolution = resolveModel(raw, loadNormalizationData())
    if (!resolution.matched) {
        const raised = recordNormalizationException(raw, resolution.reason, { table: 'x_daas_ham_asn_import', id: row.getUniqueValue() })
        const see = raised ? 'see normalization exceptions' : 'no normalization exception was raised (see the system log)'
        return rowError(`PID ${raw.model} does not map to a model; ${see}`)
    }

    const stagingSource: StagingSource = choice<StagingSource>(row, 'staging_source') === 'distributor' ? 'distributor' : DEFAULT_STAGING_SOURCE
    const values = {
        po_number: str(row, 'po_number'),
        x_daas_ham_customer_tag: str(row, 'customer_tag'),
        x_daas_ham_mac_address: str(row, 'mac_address'),
        x_daas_ham_claim_code: str(row, 'claim_code'),
        x_daas_ham_staging_source: stagingSource,
    }
    const existing = () => {
        const again = checkAsnRow(row, serial)
        return again ? rowError(again) : null
    }
    const attempt = createReceivedAsset(serial, resolution.modelId, 'in_transit', values, existing, LOCK_TRIES)
    if (!attempt.ran) return loadAgain(serial, whyNotRun(attempt, 'a scan or another row is receiving it'))
    const made = attempt.value
    if (made === 'lock lost') return loadAgain(serial, 'its lock was lost while checking it')
    if ('existing' in made) return made.existing
    if ('refused' in made) return rowError(`Asset insert failed: ${made.refused}`)
    return { state: 'inserted', comment: `Asset ${serial} in transit` }
}

/** A row the serial's lock kept from importing, marked error with why: loading it again imports or refuses it. */
function loadAgain(serial: string, why: string): RowOutcome {
    return rowError(`serial ${serial} not imported: ${why}; load this row again`)
}

/**
 * The row checked (domain/asn `asnRowProblem`): its mandatory fields, and that no Asset has its serial yet. Any
 * Asset counts, the Provider IT's too (ADR 0016), read past the importer's before-query rules (ADR 0005): an inventory
 * tech sees only their stockrooms' Assets, and an Asset in transit or on order is in none yet.
 */
function checkAsnRow(row: GlideRecord, serial: string): string | null {
    return asnRowProblem({ serial, pid: str(row, 'pid'), poNumber: str(row, 'po_number') }, !!findAnyAssetBySerial(serial))
}

