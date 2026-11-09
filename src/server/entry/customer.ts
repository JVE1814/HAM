// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideRecord, gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { awaitsSelfInstallConfirmation } from '../domain/install-confirmation.ts'
import { returnRequesterRefusal, returnRequestFindings, type RequestedReturn } from '../domain/returns.ts'
import { actsAsCustomerAdmin, customerEquipmentQuery, ROLE, SCOPE, visibilityFilter } from '../domain/visibility.ts'
import { isFleetAsset, readStage } from '../platform/assets.ts'
import { currentSession } from '../platform/session.ts'
import { bool, exists, findById, refusal, str } from '../platform/records.ts'
import { withLock } from '../platform/locks.ts'
import { awaitsReturn, installedAssetIds, raiseReturn, returnRequestLockName } from '../platform/returns.ts'
import { returnLabels } from '../platform/shipments.ts'
import { completeAttestation } from './assurance.ts'
import { completeInstall, installState } from './delivery.ts'
import { reply } from '../platform/rest-api.ts'

/*
 * Customer self-service API (P2.9, D49). Every query runs as the signed-in customer contact, so the
 * before-query visibility rules (ADR 0005) limit it to their Customer (site contacts: their Sites).
 * Asset managers may open the page as a preview, which shows every Customer; the Customer-admin
 * actions stay with Customer admins. A server read is not checked by the read ACLs, so a query with
 * `^NQ` clauses carries the reader's filter in each one itself (customerEquipmentQuery). Only fleet
 * assets (ADR 0016) are the Customer's equipment, so each read checks the Fleet flag: the rules keep a
 * contact to their Customer's hardware, fleet or not, and show staff previewing the page all of it.
 */

/** A Customer admin of their own Customer only (`actsAsCustomerAdmin`); staff raise returns via the record producer. */
function isCustomerAdmin(): boolean {
    return actsAsCustomerAdmin((role) => gs.hasRole(role))
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
    asset.addEncodedQuery(customerEquipmentQuery(visibilityFilter(session.scope, SCOPE.assets, session)))
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
            canConfirmInstall: awaitsSelfInstallConfirmation(installState(order)),
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
            dueDate: str(ret, 'due_back'),
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
    // Visibility rules apply (a contact's Customer and Sites); only a fleet asset is replaced (ADR 0016).
    const asset = findById('alm_hardware', String(input.asset ?? ''))
    if (!asset || !isFleetAsset(asset)) return reply(response, 404, { error: 'Unknown device' })
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

/**
 * POST /customer/orders/{id}/installed: a site contact confirms a self-install, also the units already shipped while a
 * line filled again after a unit was lost in transit waits for its replacement (domain/install-confirmation).
 */
export function confirmInstalled(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const order = findById('x_daas_ham_order', String(request.pathParams.id ?? ''))
    if (!order || !awaitsSelfInstallConfirmation(installState(order))) {
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
 * the listed fleet assets (ADR 0016) that are at the Site.
 */
function returnedAssetIds(siteId: string, decommission: boolean, listed: unknown): string[] {
    if (decommission) return installedAssetIds({ siteId, wholeSite: true })
    return (Array.isArray(listed) ? (listed as unknown[]) : []).map(String).filter((id) => {
        const asset = findById('alm_hardware', id)
        return !!asset && isFleetAsset(asset) && str(asset, 'x_daas_ham_site') === siteId
    })
}

/** A location named by a return request, as domain/returns reads it: whose it is and whether it is a Site at all. */
function requestedSite(site: GlideRecord): NonNullable<RequestedReturn['site']> {
    return { id: site.getUniqueValue(), customerId: str(site, 'company'), isSite: bool(site, 'x_daas_ham_is_site') }
}

/**
 * POST /customer/returns { site, assets: [ids], decommission, method }: request equipment to be taken back, under the
 * record producer's rule (domain/returns `returnRequestFindings`) for the caller's own Customer: 403 when the Return
 * create rule leaves them out, 400 when the Site is not one of their Customer's Sites. Locations have no visibility
 * rule (ADR 0005), so any location's sys_id is found: the Site is checked here, before its devices are read.
 *
 * The Customer's requests are raised one at a time, under their return-request lock (platform/returns
 * `returnRequestLockName`, ADR 0013), and only for devices not already awaiting a return: a request sent twice raises
 * one Return order, with one de-install work order and change. One that finds the lock held raises nothing (503), nor
 * does one whose devices all await a return already (409).
 */
export function requestCustomerReturn(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    if (!isCustomerAdmin()) return reply(response, 403, { error: 'Only customer admins can request returns' })
    const input = data(request)
    const { scope, customerId } = currentSession()
    const requester = { mayRequest: new GlideRecord('x_daas_ham_return_order').canCreate(), scope, customerId }
    const refused = returnRequesterRefusal(customerId, requester)
    if (refused) return reply(response, 403, { error: refused })
    const site = findById('cmn_location', String(input.site ?? ''))
    const findings = returnRequestFindings({ customerId, site: site ? requestedSite(site) : undefined }, requester)
    if (!site || findings.length > 0) return reply(response, 400, { error: findings.join('. ') })
    const raised = withLock(returnRequestLockName(customerId), () => raiseCustomerReturn(response, customerId, site, input))
    if (!raised) reply(response, 503, { error: 'Another return request of yours is being raised: try again in a moment' })
}

/** Raise the requested Return holding the Customer's return-request lock, and reply. */
function raiseCustomerReturn(response: RESTAPIResponse, customerId: string, site: GlideRecord, input: Record<string, unknown>): void {
    const decommission = input.decommission === true
    const requested = returnedAssetIds(site.getUniqueValue(), decommission, input.assets)
    if (requested.length === 0) {
        const error = decommission ? 'The site has no installed devices' : "Choose at least one of the site's devices"
        return reply(response, 400, { error })
    }
    // Read under the lock: a request sent again after the first was raised finds its devices awaiting that Return.
    const assetIds = requested.filter((id) => !awaitsReturn(id))
    if (assetIds.length === 0) return reply(response, 409, { error: 'Each device is already on a return' })
    const firstAsset = findById('alm_hardware', assetIds[0])
    const returnId = raiseReturn({
        trigger: decommission ? 'site_decommission' : 'device_removal',
        customerId,
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
