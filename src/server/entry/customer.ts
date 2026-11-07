// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideRecord, gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { awaitsSelfInstallConfirmation } from '../domain/install-confirmation'
import { DEPLOYED_STAGES, stagesQuery } from '../domain/lifecycle'
import { ROLE } from '../domain/visibility'
import { readStage } from '../platform/assets'
import { currentSession } from '../platform/session'
import { exists, findById, refusal, str } from '../platform/records'
import { installedAssetIds, raiseReturn } from '../platform/returns'
import { returnLabels } from '../platform/shipments'
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
            canConfirmInstall: awaitsSelfInstallConfirmation({ stage: str(order, 'stage'), installMode: str(order, 'install_mode') }),
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
    if (!kase.insert()) {
        gs.warn(`[x_daas_ham] No fault case for ${str(asset, 'serial_number')}: ${refusal(kase)}`)
        return reply(response, 422, { error: 'Fault not reported: the platform refused it' })
    }
    reply(response, 201, { case: str(kase, 'number') })
}

/** POST /customer/orders/{id}/installed: a site contact confirms a self-install. */
export function confirmInstalled(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const order = findById('x_daas_ham_order', String(request.pathParams.id ?? ''))
    if (!order || !awaitsSelfInstallConfirmation({ stage: str(order, 'stage'), installMode: str(order, 'install_mode') })) {
        return reply(response, 409, { error: 'This order is not waiting for a self-install confirmation' })
    }
    // Refused units stay where they were, so the confirmation can be sent again.
    const refused = completeInstall(order)
    if (refused > 0) {
        return reply(response, 422, { error: `${refused} device(s) not confirmed: the platform refused them` })
    }
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
    let refused = 0
    for (const answer of answers) {
        if (!['confirmed', 'missing', 'unknown'].includes(String(answer.response))) continue
        const item = findById('x_daas_ham_attestation_item', String(answer.id ?? ''))
        if (!item || str(item, 'attestation') !== attestation.getUniqueValue()) continue
        item.setValue('response', String(answer.response))
        if (item.update()) continue
        refused++
        const device = str(item, 'asset.serial_number')
        gs.warn(`[x_daas_ham] ${str(attestation, 'number')}: answer for ${device} not saved: ${refusal(item)}`)
    }
    // Submitted, the attestation would complete on the earlier answer, or none.
    if (refused > 0) return reply(response, 422, { error: `${refused} answer(s) not saved: the platform refused them` })
    if (input.submit === true) {
        const open = new GlideRecord('x_daas_ham_attestation_item')
        open.addQuery('attestation', attestation.getUniqueValue())
        open.addNullQuery('response')
        open.setLimit(1)
        open.query()
        if (open.hasNext()) return reply(response, 409, { error: 'Answer every device before submitting' })
        // Refused: it stays open, so the answers can be submitted again.
        if (completeAttestation(attestation)) {
            return reply(response, 422, { error: 'Attestation not submitted: the platform refused it' })
        }
    }
    reply(response, 200, { attestation: str(attestation, 'number') })
}

/**
 * The Assets a return request covers (visibility rules apply): for a decommission everything installed or shipped at
 * the Site (domain/returns `SITE_RECOVERY_STAGES`), as the record producer does, whatever the request lists; otherwise
 * the listed devices that are at the Site.
 */
function returnedAssetIds(siteId: string, decommission: boolean, listed: unknown): string[] {
    if (decommission) return installedAssetIds({ siteId, wholeSite: true })
    return (Array.isArray(listed) ? (listed as unknown[]) : []).map(String).filter((id) => {
        const asset = findById('alm_hardware', id)
        return !!asset && str(asset, 'x_daas_ham_site') === siteId
    })
}

/** POST /customer/returns { site, assets: [ids], decommission, method }: request equipment to be taken back. */
export function requestCustomerReturn(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    if (!isCustomerAdmin()) return reply(response, 403, { error: 'Only customer admins can request returns' })
    const input = data(request)
    const site = findById('cmn_location', String(input.site ?? ''))
    const decommission = input.decommission === true
    const assetIds = site ? returnedAssetIds(site.getUniqueValue(), decommission, input.assets) : []
    if (!site || assetIds.length === 0) {
        return reply(response, 400, { error: decommission ? 'Choose a site with installed devices' : 'Choose a site and at least one of its devices' })
    }
    const firstAsset = findById('alm_hardware', assetIds[0])
    const returnId = raiseReturn({
        trigger: decommission ? 'site_decommission' : 'device_removal',
        customerId: str(firstAsset ?? site, 'company'),
        siteId: site.getUniqueValue(),
        agreementId: firstAsset ? str(firstAsset, 'x_daas_ham_agreement') : '',
        method: input.method === 'fsm_deinstall' ? 'fsm_deinstall' : 'ship_back',
        assetIds,
        openFieldWork: true,
        description: `Customer return request from ${str(site, 'name')}`,
    })
    // Refused: nothing was moved, so the request can be sent again.
    if (!returnId) return reply(response, 422, { error: 'Return not raised: the platform refused it' })
    // A Return no device could be added to (each refused, logged, or already awaiting a return) is closed at once.
    if (!exists('x_daas_ham_return_order_line', `return_order=${returnId}`)) {
        return reply(response, 422, { error: 'No device could be added: each is already on a return or was refused' })
    }
    reply(response, 201, { returnOrder: findById('x_daas_ham_return_order', returnId)?.getDisplayValue('number') ?? returnId })
}
