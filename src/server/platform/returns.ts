import { GlideDateTime, GlideRecord } from '@servicenow/glide'
import { appendTo } from '../domain/collections'
import { isDeployed, stagesQuery } from '../domain/lifecycle'
import { feeAmount, returnDueDate, type FeeType } from '../domain/returns'
import { moveAndSave, readStage } from './assets'
import { todayIso } from './clock'
import { openChange, openWorkOrder } from './field-work'
import { findById, num, str } from './records'

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

/** Create a Return order with one line per Asset; installed Assets become pending return. */
export function raiseReturn(request: ReturnRequest): string {
    const order = new GlideRecord('x_daas_ham_return_order')
    order.initialize()
    order.setValue('trigger', request.trigger)
    order.setValue('customer', request.customerId)
    order.setValue('site', request.siteId)
    order.setValue('agreement', request.agreementId)
    order.setValue('method', request.method)
    order.setValue('source_order', request.sourceOrderId ?? '')
    order.setValue('short_description', request.description)
    order.insert()
    completeReturn(order, request)
    return order.getUniqueValue()
}

/** Fill in a saved Return order header: due date, lines, de-install work. */
export function completeReturn(order: GlideRecord, request: ReturnRequest): void {
    const agreement = findById('x_daas_ham_agreement', request.agreementId)
    const allowance = agreement ? num(agreement, 'overdue_return_days') || 30 : 30
    order.setValue('agreement', request.agreementId)
    order.setValue('due_date', returnDueDate(todayIso(), allowance))
    order.setValue('state', 2)

    let lines = 0
    for (const assetId of request.assetIds) {
        const asset = findById('alm_hardware', assetId)
        if (!asset || latestReturnLine(assetId, 'awaiting')) continue
        const stage = readStage(asset)
        // Leaving service closes the Asset's service interval (entry/assets.ts onAssetServiceChange).
        if (isDeployed(stage) && stage !== 'pending_return') moveAndSave(asset, 'pending_return', `return ${str(order, 'number')}`)
        const line = new GlideRecord('x_daas_ham_return_order_line')
        line.initialize()
        line.setValue('return_order', order.getUniqueValue())
        line.setValue('asset', assetId)
        line.insert()
        lines++
    }

    if (lines === 0) {
        // Nothing installed (or everything already on another Return order): close straight away.
        order.setValue('state', 3)
        order.setValue('work_notes', 'No equipment to bring back.')
    } else if (request.openFieldWork && request.method === 'fsm_deinstall') {
        const context = {
            customerId: request.customerId,
            siteId: request.siteId,
            description: request.description,
            source: { field: 'x_daas_ham_return_order' as const, id: order.getUniqueValue() },
        }
        const changeId = openChange(context, 'normal')
        order.setValue('change_request', changeId)
        order.setValue('work_order', openWorkOrder(context, 'de_install', changeId, false))
    }
    order.update()
}

export interface InstalledFilter {
    agreementId?: string
    siteId?: string
    orderId?: string
}

/** Assets installed at a Site (in service, temporary or awaiting first sighting), by Agreement, Site or Order. */
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
    asset.addEncodedQuery(stagesQuery(['in_service', 'temporary_deployment', 'pending_in_service'], base))
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
        fee.update()
    }
}

export function recordFee(type: FeeType, asset: GlideRecord, returnOrderId: string): void {
    const agreement = findById('x_daas_ham_agreement', str(asset, 'x_daas_ham_agreement'))
    const amount = feeAmount(type, {
        lost: agreement ? num(agreement, 'lost_asset_fee') : 0,
        damaged: agreement ? num(agreement, 'damage_fee') : 0,
        late_return: agreement ? num(agreement, 'late_return_fee') : 0,
    })
    if (amount <= 0) return
    const fee = new GlideRecord('x_daas_ham_fee_event')
    fee.initialize()
    fee.setValue('fee_type', type)
    fee.setValue('customer', str(asset, 'company'))
    fee.setValue('agreement', str(asset, 'x_daas_ham_agreement'))
    fee.setValue('asset', asset.getUniqueValue())
    fee.setValue('return_order', returnOrderId)
    fee.setValue('amount', amount)
    fee.setValue('occurred_on', todayIso())
    fee.insert()
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
    order.update()
}

export function stampNow(record: GlideRecord, field: string): void {
    record.setValue(field, new GlideDateTime().getValue())
}
