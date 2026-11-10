import { GlideRecord, gs } from '@servicenow/glide'
import { addDays } from '../domain/calendar.ts'
import { RMA_AT_OEM, RMA_AWAITED, RMA_OPEN, type OpenRma, type RmaReuse } from '../domain/oem-rma.ts'
import { lineStillOpen } from '../domain/sourcing.ts'
import { LINE_STAGE, type OemVendor, RMA_STATE, type RmaState } from '../domain/vocabulary.ts'
import { isFleetAsset, moveRefusal } from './assets.ts'
import { nowGlide, todayIso } from './clock.ts'
import { count, findById, refusal, str, warnRefused } from './records.ts'

/** OEM RMA records (opening the RMA with the vendor is manual, ADR 0008). */

/** The vendor an RMA is opened with when the defective Asset's Model names no OEM source. */
const DEFAULT_RMA_VENDOR: OemVendor = 'cisco'

/** How many days after its RMA is opened the defective unit is due back at the OEM. */
const SHIP_BACK_DAYS = 10

/** Open an OEM RMA for an advance replacement: its sys_id, or '' (logged) when the platform refuses it. */
export function openOemRma(input: { defectiveAsset: GlideRecord; orderLineId: string; caseId: string }): string {
    const rma = new GlideRecord('x_daas_ham_oem_rma')
    rma.initialize()
    rma.setValue('vendor', str(input.defectiveAsset, 'model.x_daas_ham_oem_source') || DEFAULT_RMA_VENDOR)
    rma.setValue('defective_asset', input.defectiveAsset.getUniqueValue())
    rma.setValue('order_line', input.orderLineId)
    rma.setValue('case', input.caseId)
    rma.setValue('advance_replacement', true)
    rma.setValue('state', RMA_STATE.to_open)
    rma.setValue('ship_back_due', addDays(todayIso(), SHIP_BACK_DAYS))
    const rmaId = rma.insert()
    if (rmaId) return rmaId
    warnRefused(rma, `No OEM RMA for ${str(input.defectiveAsset, 'serial_number')}`)
    return ''
}

/** The RMAs still open for a defective Asset (domain/oem-rma `RMA_OPEN`), oldest first, with the line each serves. */
export function openRmasFor(defectiveAssetId: string): OpenRma[] {
    const rma = new GlideRecord('x_daas_ham_oem_rma')
    rma.addQuery('defective_asset', defectiveAssetId)
    rma.addQuery('state', 'IN', RMA_OPEN.join(','))
    rma.orderBy('sys_created_on')
    rma.query()
    const open: OpenRma[] = []
    while (rma.next()) {
        const line = { lineStage: str(rma, 'order_line.line_stage'), orderStage: str(rma, 'order_line.order.stage') }
        open.push({
            rmaId: rma.getUniqueValue(),
            rmaNumber: str(rma, 'rma_number'),
            state: str(rma, 'state') as RmaState,
            lineId: str(rma, 'order_line'),
            // With no line both stages read '', which is no open line.
            lineOpen: lineStillOpen(line),
        })
    }
    return open
}

/**
 * Put the RMA `reuse` names (domain/oem-rma `advanceReplacementRma`) under the Order line, in the state it takes, so
 * the line counts its replacement as on its way; false (logged) when the platform refuses.
 */
export function reuseOemRma(reuse: RmaReuse, orderLineId: string): boolean {
    const rma = findById('x_daas_ham_oem_rma', reuse.rma.rmaId)
    const notReused = `OEM RMA ${reuse.rma.rmaNumber || reuse.rma.rmaId} not reused`
    if (!rma) {
        gs.warn(`[x_daas_ham] ${notReused}: not found`)
        return false
    }
    rma.setValue('order_line', orderLineId)
    rma.setValue('state', reuse.state)
    if (rma.update()) return true
    warnRefused(rma, notReused)
    return false
}

/**
 * The replacement unit announced under the RMA arrived: the RMA is marked replacement received, with the unit's
 * serial. A refused save is logged: the unit still goes to its line, which needs it, and an RMA left open counts as a
 * replacement still to come.
 */
export function markReplacementReceived(rmaId: string, replacementSerial: string): void {
    const rma = findById('x_daas_ham_oem_rma', rmaId)
    if (!rma) return
    rma.setValue('state', RMA_STATE.replacement_received)
    rma.setValue('replacement_serial', replacementSerial)
    if (!rma.update()) warnRefused(rma, `RMA ${str(rma, 'rma_number')} not marked replacement received`)
}

/** OEM advance replacements still expected for an Order line. */
export function openRmaCount(orderLineId: string): number {
    return count('x_daas_ham_oem_rma', `order_line=${orderLineId}^stateIN${RMA_AWAITED.join(',')}`)
}

/** The Order line waiting for the OEM replacement announced under this RMA number. */
export function lineAwaitingRma(rmaNumber: string, modelId: string): { lineId: string; rmaId: string } | null {
    if (!rmaNumber) return null
    const rma = new GlideRecord('x_daas_ham_oem_rma')
    rma.addQuery('rma_number', rmaNumber)
    rma.addQuery('order_line.line_stage', LINE_STAGE.awaiting_stock)
    rma.addQuery('order_line.model', modelId)
    rma.setLimit(1)
    rma.query()
    return rma.next() ? { lineId: str(rma, 'order_line'), rmaId: rma.getUniqueValue() } : null
}


/** The most RMAs of one vendor a status sync asks about. */
const RMAS_PER_SYNC = 200

/**
 * `vendor`'s RMAs to ask the OEM about: those open with it (`RMA_AT_OEM`) that have an RMA number, at most
 * RMAS_PER_SYNC, least recently synced (never synced) first; their sys_ids, and their RMA numbers each once.
 */
export function rmasToAskAbout(vendor: OemVendor): { ids: string[]; rmaNumbers: string[] } {
    const rma = new GlideRecord('x_daas_ham_oem_rma')
    rma.addQuery('vendor', vendor)
    rma.addQuery('state', 'IN', RMA_AT_OEM.join(','))
    rma.addNotNullQuery('rma_number')
    rma.orderBy('last_synced')
    rma.setLimit(RMAS_PER_SYNC)
    rma.query()
    const ids: string[] = []
    const rmaNumbers = new Set<string>()
    while (rma.next()) {
        ids.push(rma.getUniqueValue())
        rmaNumbers.add(str(rma, 'rma_number'))
    }
    return { ids, rmaNumbers: [...rmaNumbers] }
}

/**
 * Stamp the asked RMAs synced now, each with the status the OEM answered for its number (kept when it gave none).
 * Returns why each RMA the platform refused was refused: it stays first in line for the next sync.
 */
export function recordRmaStatuses(rmaIds: readonly string[], statusOf: ReadonlyMap<string, string>): string[] {
    const syncedAt = nowGlide()
    const refused: string[] = []
    const asked = new GlideRecord('x_daas_ham_oem_rma')
    asked.addQuery('sys_id', 'IN', rmaIds.join(','))
    asked.query()
    while (asked.next()) {
        const status = statusOf.get(str(asked, 'rma_number'))
        if (status !== undefined) asked.setValue('status', status)
        asked.setValue('last_synced', syncedAt)
        if (!asked.update()) refused.push(`${str(asked, 'rma_number')} not saved: ${refusal(asked)}`)
    }
    return refused
}

/**
 * The defective unit of an RMA went back to the manufacturer: retire it (a fleet asset only, ADR 0016), then mark the
 * RMA defective returned. Why that was not done, to tell the user ('' once done, or when the RMA names no Asset the
 * user can read). The RMA records the return only once the unit is retired; a unit retired whose RMA the platform
 * then refuses says so, and asked again it finds the unit retired (no move) and marks the RMA.
 */
export function returnDefectiveToOem(rma: GlideRecord): string {
    const asset = findById('alm_hardware', str(rma, 'defective_asset'))
    if (!asset) return ''
    if (!isFleetAsset(asset)) return 'The defective asset is not a fleet asset: it is not retired here'
    const serial = str(asset, 'serial_number')
    const refused = moveRefusal(asset, 'returned_to_oem')
    if (refused) return `${serial} not retired: ${refused}`
    const returned: RmaState = 'defective_returned'
    rma.setValue('state', returned)
    if (rma.update()) return ''
    return `${serial} is retired, but the RMA was not marked returned: ${refusal(rma)}. Press again once that is fixed`
}
