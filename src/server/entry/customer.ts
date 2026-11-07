// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideRecord, gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { DEPLOYED_STAGES, stagesQuery } from '../domain/lifecycle'
import { OPEN_SHIPMENTS } from '../domain/shipping'
import { ROLE } from '../domain/visibility'
import { readStage } from '../platform/assets'
import { currentSession } from '../platform/session'
import { findById, str } from '../platform/records'
import { raiseReturn } from '../platform/returns'
import { completeAttestation } from './assurance'
import { completeInstall } from './delivery'
import { reply } from '../platform/rest-api'

/*
 * Customer self-service API (P2.9, D49). Every query runs as the signed-in customer contact, so the
 * before-query visibility rules (ADR 0005) limit it to their Customer (site contacts: their Sites).
 */

function isCustomerAdmin(): boolean {
    return gs.hasRole(ROLE.customerAdmin) || gs.hasRole(ROLE.assetManager)
}

function allowed(response: RESTAPIResponse): boolean {
    if (gs.hasRole(ROLE.customerAdmin) || gs.hasRole(ROLE.siteContact) || gs.hasRole(ROLE.assetManager)) return true
    reply(response, 403, { error: 'Requires a customer admin or site contact role' })
    return false
}

function data(request: RESTAPIRequest): Record<string, unknown> {
    return (request.body.data as Record<string, unknown> | null) ?? {}
}

/** GET /customer/overview: what the customer sees on their page. */
export function customerOverview(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const session = currentSession()

    const assets: object[] = []
    const asset = new GlideRecord('alm_hardware')
    asset.addEncodedQuery(stagesQuery(DEPLOYED_STAGES))
    asset.orderBy('x_daas_ham_site')
    asset.setLimit(5000)
    asset.query()
    while (asset.next()) {
        assets.push({
            id: asset.getUniqueValue(),
            tag: str(asset, 'asset_tag'),
            serial: str(asset, 'serial_number'),
            customerTag: str(asset, 'x_daas_ham_customer_tag'),
            model: asset.getDisplayValue('model'),
            site: asset.getDisplayValue('x_daas_ham_site'),
            siteId: str(asset, 'x_daas_ham_site'),
            stage: readStage(asset) ?? 'unknown',
            inServiceDate: str(asset, 'x_daas_ham_in_service_date').slice(0, 10),
            refreshDue: str(asset, 'x_daas_ham_refresh_due'),
        })
    }

    const orders: object[] = []
    const order = new GlideRecord('x_daas_ham_order')
    order.addQuery('stage', 'NOT IN', 'complete,cancelled,rejected')
    order.orderByDesc('sys_created_on')
    order.setLimit(200)
    order.query()
    while (order.next()) {
        orders.push({
            id: order.getUniqueValue(),
            number: str(order, 'number'),
            type: order.getDisplayValue('order_type'),
            site: order.getDisplayValue('site'),
            stage: str(order, 'stage'),
            stageLabel: order.getDisplayValue('stage'),
            installMode: str(order, 'install_mode'),
            canConfirmInstall: str(order, 'stage') === 'installing' && str(order, 'install_mode') === 'self_install',
        })
    }

    const returns: Array<{ id: string; number: string; site: string; trigger: string; dueDate: string }> = []
    const ret = new GlideRecord('x_daas_ham_return_order')
    ret.addQuery('active', true)
    ret.setLimit(200)
    ret.query()
    while (ret.next()) {
        returns.push({
            id: ret.getUniqueValue(),
            number: str(ret, 'number'),
            site: ret.getDisplayValue('site'),
            trigger: ret.getDisplayValue('trigger'),
            dueDate: str(ret, 'due_date'),
        })
    }
    const labels = returnLabels(returns.map((r) => r.id))
    const labelledReturns = returns.map((r) => ({ ...r, ...(labels.get(r.id) ?? { labelUrl: '', trackingNumber: '' }) }))

    const attestations: object[] = []
    const attestation = new GlideRecord('x_daas_ham_attestation')
    attestation.addQuery('active', true)
    attestation.setLimit(50)
    attestation.query()
    while (attestation.next()) {
        const items: object[] = []
        const item = new GlideRecord('x_daas_ham_attestation_item')
        item.addQuery('attestation', attestation.getUniqueValue())
        item.query()
        while (item.next()) {
            items.push({
                id: item.getUniqueValue(),
                tag: str(item, 'asset.asset_tag'),
                serial: str(item, 'asset.serial_number'),
                model: item.getDisplayValue('asset.model'),
                response: str(item, 'response'),
            })
        }
        attestations.push({ id: attestation.getUniqueValue(), number: str(attestation, 'number'), site: attestation.getDisplayValue('site'), items })
    }

    reply(response, 200, {
        customer: findById('core_company', session.customerId)?.getDisplayValue('name') ?? '',
        isCustomerAdmin: isCustomerAdmin(),
        assets,
        orders,
        returns: labelledReturns,
        attestations,
    })
}

/** The latest prepaid return label still in use (not delivered or returned) of each Return order that has one. */
function returnLabels(returnOrderIds: readonly string[]): Map<string, { labelUrl: string; trackingNumber: string }> {
    const labels = new Map<string, { labelUrl: string; trackingNumber: string }>()
    if (returnOrderIds.length === 0) return labels
    const shipment = new GlideRecord('x_daas_ham_shipment')
    shipment.addEncodedQuery(`direction=return^${OPEN_SHIPMENTS}^return_orderIN${returnOrderIds.join(',')}`)
    shipment.orderBy('sys_created_on')
    shipment.query()
    while (shipment.next()) labels.set(str(shipment, 'return_order'), { labelUrl: str(shipment, 'label_url'), trackingNumber: str(shipment, 'tracking_number') })
    return labels
}

/** POST /customer/faults { asset, description }: report a faulty device as a CSM case. */
export function reportFault(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const input = data(request)
    const asset = findById('alm_hardware', String(input.asset ?? '')) // visibility rules apply
    if (!asset) return reply(response, 404, { error: 'Unknown device' })
    const kase = new GlideRecord('sn_customerservice_case')
    kase.initialize()
    kase.setValue('account', str(asset, 'company'))
    kase.setValue('contact', gs.getUserID())
    kase.setValue('short_description', `Faulty device ${str(asset, 'asset_tag') || str(asset, 'serial_number')} at ${asset.getDisplayValue('x_daas_ham_site')}`)
    kase.setValue('description', String(input.description ?? ''))
    kase.setValue('x_daas_ham_failed_asset', asset.getUniqueValue())
    kase.insert()
    reply(response, 201, { case: str(kase, 'number') })
}

/** POST /customer/orders/{id}/installed: a site contact confirms a self-install. */
export function confirmInstalled(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const order = findById('x_daas_ham_order', String(request.pathParams.id ?? ''))
    if (!order || str(order, 'stage') !== 'installing' || str(order, 'install_mode') !== 'self_install') {
        return reply(response, 409, { error: 'This order is not waiting for a self-install confirmation' })
    }
    completeInstall(order)
    reply(response, 200, { order: str(order, 'number') })
}

/** POST /customer/attestations/{id} { items: [{ id, response }], submit }: answer an attestation. */
export function answerAttestation(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    if (!isCustomerAdmin()) return reply(response, 403, { error: 'Only customer admins attest equipment' })
    const attestation = findById('x_daas_ham_attestation', String(request.pathParams.id ?? ''))
    if (!attestation || str(attestation, 'state') === '3') return reply(response, 404, { error: 'No open attestation' })
    const input = data(request)
    const answers = Array.isArray(input.items) ? (input.items as Array<{ id?: string; response?: string }>) : []
    for (const answer of answers) {
        if (!['confirmed', 'missing', 'unknown'].includes(String(answer.response))) continue
        const item = findById('x_daas_ham_attestation_item', String(answer.id ?? ''))
        if (!item || str(item, 'attestation') !== attestation.getUniqueValue()) continue
        item.setValue('response', String(answer.response))
        item.update()
    }
    if (input.submit === true) {
        const open = new GlideRecord('x_daas_ham_attestation_item')
        open.addQuery('attestation', attestation.getUniqueValue())
        open.addNullQuery('response')
        open.setLimit(1)
        open.query()
        if (open.hasNext()) return reply(response, 409, { error: 'Answer every device before submitting' })
        completeAttestation(attestation)
    }
    reply(response, 200, { attestation: str(attestation, 'number') })
}

/** POST /customer/returns { site, assets: [ids], decommission, method }: request equipment to be taken back. */
export function requestCustomerReturn(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    if (!isCustomerAdmin()) return reply(response, 403, { error: 'Only customer admins can request returns' })
    const input = data(request)
    const site = findById('cmn_location', String(input.site ?? ''))
    const assetIds = (Array.isArray(input.assets) ? (input.assets as unknown[]) : [])
        .map(String)
        .filter((id) => {
            const asset = findById('alm_hardware', id) // visibility rules apply
            return !!asset && str(asset, 'x_daas_ham_site') === site?.getUniqueValue()
        })
    if (!site || assetIds.length === 0) return reply(response, 400, { error: 'Choose a site and at least one of its devices' })
    const firstAsset = findById('alm_hardware', assetIds[0])
    const returnId = raiseReturn({
        trigger: input.decommission === true ? 'site_decommission' : 'device_removal',
        customerId: str(firstAsset ?? site, 'company'),
        siteId: site.getUniqueValue(),
        agreementId: firstAsset ? str(firstAsset, 'x_daas_ham_agreement') : '',
        method: input.method === 'fsm_deinstall' ? 'fsm_deinstall' : 'ship_back',
        assetIds,
        openFieldWork: true,
        description: `Customer return request from ${str(site, 'name')}`,
    })
    reply(response, 201, { returnOrder: findById('x_daas_ham_return_order', returnId)?.getDisplayValue('number') ?? returnId })
}
