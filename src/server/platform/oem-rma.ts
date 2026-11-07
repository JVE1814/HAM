import { GlideRecord, gs } from '@servicenow/glide'
import { addDays } from '../domain/calendar'
import { todayIso } from './clock'
import { refusal, str } from './records'

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
    const reason = refusal(rma)
    gs.warn(`[x_daas_ham] No OEM RMA for ${str(input.defectiveAsset, 'serial_number')}: ${reason}`)
    return ''
}

/** OEM advance replacements still expected for an Order line. */
export function openRmaCount(orderLineId: string): number {
    const rma = new GlideRecord('x_daas_ham_oem_rma')
    rma.addQuery('order_line', orderLineId)
    rma.addQuery('state', 'IN', 'to_open,open')
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
