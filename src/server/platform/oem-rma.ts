import { GlideRecord, gs } from '@servicenow/glide'
import { addDays } from '../domain/calendar.ts'
import { lineStillOpen, RMA_AWAITED, RMA_OPEN, type OpenRma, type RmaReuse } from '../domain/sourcing.ts'
import type { RmaState } from '../domain/vocabulary.ts'
import { todayIso } from './clock.ts'
import { findById, str, warnRefused } from './records.ts'

/** OEM RMA records (opening the RMA with the vendor is manual, ADR 0008). */

/** Open an OEM RMA for an advance replacement: its sys_id, or '' (logged) when the platform refuses it. */
export function openOemRma(input: { defectiveAsset: GlideRecord; orderLineId: string; caseId: string }): string {
    const rma = new GlideRecord('x_daas_ham_oem_rma')
    rma.initialize()
    rma.setValue('vendor', str(input.defectiveAsset, 'model.x_daas_ham_oem_source') || 'cisco')
    rma.setValue('defective_asset', input.defectiveAsset.getUniqueValue())
    rma.setValue('order_line', input.orderLineId)
    rma.setValue('case', input.caseId)
    rma.setValue('advance_replacement', true)
    rma.setValue('state', 'to_open')
    rma.setValue('ship_back_due', addDays(todayIso(), 10))
    const rmaId = rma.insert()
    if (rmaId) return rmaId
    warnRefused(rma, `No OEM RMA for ${str(input.defectiveAsset, 'serial_number')}`)
    return ''
}

/** The RMAs still open for a defective Asset (domain/sourcing `RMA_OPEN`), oldest first, with the line each serves. */
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
 * Put the RMA `reuse` names (domain/sourcing `advanceReplacementRma`) under the Order line, in the state it takes, so
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
    rma.setValue('state', 'replacement_received')
    rma.setValue('replacement_serial', replacementSerial)
    if (!rma.update()) warnRefused(rma, `RMA ${str(rma, 'rma_number')} not marked replacement received`)
}

/** OEM advance replacements still expected for an Order line. */
export function openRmaCount(orderLineId: string): number {
    const rma = new GlideRecord('x_daas_ham_oem_rma')
    rma.addQuery('order_line', orderLineId)
    rma.addQuery('state', 'IN', RMA_AWAITED.join(','))
    rma.query()
    return rma.getRowCount()
}

/** The Order line waiting for the OEM replacement announced under this RMA number. */
export function lineAwaitingRma(rmaNumber: string, modelId: string): { lineId: string; rmaId: string } | null {
    if (!rmaNumber) return null
    const rma = new GlideRecord('x_daas_ham_oem_rma')
    rma.addQuery('rma_number', rmaNumber)
    rma.addQuery('order_line.line_stage', 'awaiting_stock')
    rma.addQuery('order_line.model', modelId)
    rma.setLimit(1)
    rma.query()
    return rma.next() ? { lineId: str(rma, 'order_line'), rmaId: rma.getUniqueValue() } : null
}
