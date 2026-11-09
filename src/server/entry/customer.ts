import { gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { awaitsSelfInstallConfirmation } from '../domain/install-confirmation.ts'
import type {
    AttestationReceipt,
    CustomerOverview,
    FaultReport,
    InstallConfirmation,
    ReturnRequestReceipt,
} from '../domain/rest-contracts.ts'
import { actsAsCustomerAdmin, ROLE } from '../domain/visibility.ts'
import {
    completeAttestation,
    findUnclosedAttestation,
    hasUnansweredItems,
    saveAttestationAnswers,
    type AttestationAnswer,
} from '../platform/attestations.ts'
import {
    customerEquipment,
    customerName,
    openAttestations,
    openFaultCase,
    openReturns,
    ordersUnderWay,
} from '../platform/customer-page.ts'
import { currentSession } from '../platform/session.ts'
import { findById, str } from '../platform/records.ts'
import { requestReturn } from '../platform/returns.ts'
import { completeInstall, installState } from '../platform/delivery.ts'
import { reply } from '../platform/rest-api.ts'

/*
 * Customer self-service API (P2.9, D49). Every query runs as the signed-in customer contact, so the
 * before-query visibility rules (ADR 0005) limit it to their Customer (site contacts: their Sites).
 * Asset managers may open the page as a preview, which shows every Customer (platform/customer-page);
 * the Customer-admin actions stay with Customer admins.
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

/** GET /customer/overview: what the customer sees on their page (platform/customer-page). */
export function customerOverview(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const session = currentSession()
    reply(response, 200, {
        customer: customerName(session.customerId),
        isCustomerAdmin: isCustomerAdmin(),
        assets: customerEquipment(session),
        orders: ordersUnderWay(),
        returns: openReturns(),
        attestations: openAttestations(),
    } satisfies CustomerOverview)
}

/** POST /customer/faults { asset, description }: report a faulty device as a CSM case. */
export function reportFault(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const input = data(request)
    const fault = openFaultCase(String(input.asset ?? ''), String(input.description ?? ''))
    if (fault.opened) return reply(response, 201, { case: fault.number } satisfies FaultReport)
    if (fault.reason === 'unknown') return reply(response, 404, { error: 'Unknown device' })
    reply(response, 422, { error: 'Fault not reported: the platform refused it' })
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
    reply(response, 200, { order: str(order, 'number') } satisfies InstallConfirmation)
}

/** POST /customer/attestations/{id} { items: [{ id, response }], submit }: answer an attestation. */
export function answerAttestation(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    if (!isCustomerAdmin()) return reply(response, 403, { error: 'Only customer admins attest equipment' })
    const attestation = findUnclosedAttestation(String(request.pathParams.id ?? ''))
    if (!attestation) return reply(response, 404, { error: 'No open attestation' })
    const input = data(request)
    const refused = saveAttestationAnswers(attestation, Array.isArray(input.items) ? (input.items as AttestationAnswer[]) : [])
    // Submitted, the attestation would complete on the earlier answer, or none.
    if (refused > 0) return reply(response, 422, { error: `${refused} answer(s) not saved: the platform refused them` })
    if (input.submit === true) {
        if (hasUnansweredItems(attestation)) return reply(response, 409, { error: 'Answer every device before submitting' })
        // Refused: it stays open, so the answers can be submitted again.
        if (completeAttestation(attestation)) {
            return reply(response, 422, { error: 'Attestation not submitted: the platform refused it' })
        }
    }
    reply(response, 200, { attestation: str(attestation, 'number') } satisfies AttestationReceipt)
}

/**
 * POST /customer/returns { site, assets: [ids], decommission, method }: request equipment to be taken back, under the
 * record producer's rule (platform/returns `requestReturn`) for the caller's own Customer: 403 when the Return create
 * rule leaves them out, 400 when the Site is not one of their Customer's Sites or the request names no device there.
 */
export function requestCustomerReturn(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    if (!isCustomerAdmin()) return reply(response, 403, { error: 'Only customer admins can request returns' })
    const input = data(request)
    const outcome = requestReturn({
        customerId: currentSession().customerId,
        siteId: String(input.site ?? ''),
        decommission: input.decommission === true,
        listedAssetIds: (Array.isArray(input.assets) ? (input.assets as unknown[]) : []).map(String),
        method: input.method === 'fsm_deinstall' ? 'fsm_deinstall' : 'ship_back',
        describe: (siteName) => `Customer return request from ${siteName}`,
    })
    if (!outcome.raised) {
        if (outcome.reason === 'forbidden') return reply(response, 403, { error: outcome.why })
        if (outcome.reason !== 'refused') return reply(response, 400, { error: outcome.why })
        // Refused: nothing was moved, so the request can be sent again.
        return reply(response, 422, { error: 'Return not raised: the platform refused it' })
    }
    // A Return no device could be added to (each refused, logged, or already awaiting a return) is closed at once.
    if (outcome.lines === 0) {
        return reply(response, 422, { error: 'No device could be added: each is already on a return or was refused' })
    }
    const returnOrder = findById('x_daas_ham_return_order', outcome.returnOrderId)?.getDisplayValue('number') ?? outcome.returnOrderId
    reply(response, 201, { returnOrder } satisfies ReturnRequestReceipt)
}
