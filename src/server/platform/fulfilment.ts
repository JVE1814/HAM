import { GlideRecord } from '@servicenow/glide'
import { lineStageFor, orderStageFor, type LineStage } from '../domain/fulfilment'
import type { Stage } from '../domain/lifecycle'
import { readStage } from './assets'
import { findById, num, str } from './records'

/** Keeps Order-line and Order stages in step with their Assets (derived, see domain/fulfilment). */

/** Order stages the derived stage never overrides. */
const FIXED_ORDER_STAGES = ['draft', 'awaiting_approval', 'rejected', 'cancelled']

export function lineAssetStages(lineId: string): Array<Stage | null> {
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('x_daas_ham_order_line', lineId)
    asset.query()
    const stages: Array<Stage | null> = []
    while (asset.next()) stages.push(readStage(asset))
    return stages
}

export function recomputeLine(lineId: string): void {
    const line = findById('x_daas_ham_order_line', lineId)
    if (!line) return
    const current = str(line, 'line_stage') as LineStage
    if (current === 'new') return // not sourced yet
    const next = lineStageFor({
        quantity: num(line, 'quantity'),
        assetStages: lineAssetStages(lineId),
        cancelled: current === 'cancelled',
    })
    if (next !== current) {
        line.setValue('line_stage', next)
        line.update()
    }
    recomputeOrder(str(line, 'order'))
}

export function recomputeOrder(orderId: string): void {
    const order = findById('x_daas_ham_order', orderId)
    if (!order || FIXED_ORDER_STAGES.includes(str(order, 'stage'))) return
    const line = new GlideRecord('x_daas_ham_order_line')
    line.addQuery('order', orderId)
    line.query()
    const stages: LineStage[] = []
    while (line.next()) stages.push(str(line, 'line_stage') as LineStage)
    if (stages.length === 0) return
    const next = orderStageFor(stages)
    if (next === str(order, 'stage')) return
    order.setValue('stage', next)
    if (next === 'complete') order.setValue('state', 3)
    if (next === 'cancelled') order.setValue('state', 7)
    order.update()
}
