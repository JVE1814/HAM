import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import type {
    AttestationAnswers,
    AttestationReceipt,
    CustomerOverview,
    FaultReport,
    FaultRequest,
    InstallConfirmation,
    ReturnRequestBody,
    ReturnRequestReceipt,
} from '../domain/rest-contracts.ts'
import { sentDeviceList, uniqueIds } from '../domain/customer-requests.ts'
import { actsAsCustomerAdmin } from '../domain/visibility.ts'
import { CUSTOMER_PAGE_USERS } from '../domain/roles.ts'
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
import { confirmInstall } from '../platform/delivery.ts'
import { bodyOf, pathParam, reply, requireRole } from '../platform/rest-api.ts'

function allowed(response: RESTAPIResponse): boolean {
    return requireRole(response, CUSTOMER_PAGE_USERS, 'Requires a customer admin or site contact role')
}

export function customerOverview(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const session = currentSession()
    reply(response, 200, {
        customer: customerName(session.customerId),
        isCustomerAdmin: actsAsCustomerAdmin(session.scope),
        assets: customerEquipment(),
        orders: ordersUnderWay(),
        returns: openReturns(),
        attestations: openAttestations(),
    } satisfies CustomerOverview)
}

export function reportFault(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const input = bodyOf<FaultRequest>(request)
    const fault = openFaultCase(String(input.asset ?? ''), String(input.description ?? ''))
    if (fault.opened) return reply(response, 201, { case: fault.number } satisfies FaultReport)
    if (fault.reason === 'unknown') return reply(response, 404, { error: 'Unknown device' })
    reply(response, 422, { error: 'Fault not reported: the platform refused it' })
}

export function confirmInstalled(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const order = findById('x_daas_ham_order', pathParam(request, 'id'))
    const outcome = order ? confirmInstall(order, 'customer') : null
    if (!order || !outcome?.confirmed) {
        return reply(response, 409, { error: 'This order is not waiting for a self-install confirmation' })
    }
    if (outcome.refused > 0) {
        return reply(response, 422, { error: `${outcome.refused} device(s) not confirmed: the platform refused them` })
    }
    reply(response, 200, { order: str(order, 'number') } satisfies InstallConfirmation)
}

export function answerAttestation(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    if (!actsAsCustomerAdmin(currentSession().scope)) return reply(response, 403, { error: 'Only customer admins attest equipment' })
    const attestation = findUnclosedAttestation(pathParam(request, 'id'))
    if (!attestation) return reply(response, 404, { error: 'No open attestation' })
    const input = bodyOf<AttestationAnswers>(request)
    const answers = sentDeviceList(input.items)
    if ('error' in answers) return reply(response, 400, { error: answers.error })
    const refused = saveAttestationAnswers(attestation, answers.list as AttestationAnswer[])
    if (refused > 0) return reply(response, 422, { error: `${refused} answer(s) not saved: the platform refused them` })
    if (input.submit === true) {
        if (hasUnansweredItems(attestation)) return reply(response, 409, { error: 'Answer every device before submitting' })
        if (completeAttestation(attestation)) {
            return reply(response, 422, { error: 'Attestation not submitted: the platform refused it' })
        }
    }
    reply(response, 200, { attestation: str(attestation, 'number') } satisfies AttestationReceipt)
}

export function requestCustomerReturn(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const session = currentSession()
    if (!actsAsCustomerAdmin(session.scope)) return reply(response, 403, { error: 'Only customer admins can request returns' })
    const input = bodyOf<ReturnRequestBody>(request)
    const listed = sentDeviceList(input.assets)
    if ('error' in listed) return reply(response, 400, { error: listed.error })
    const outcome = requestReturn({
        customerId: session.customerId,
        siteId: String(input.site ?? ''),
        decommission: input.decommission === true,
        listedAssetIds: uniqueIds(listed.list),
        method: input.method === 'fsm_deinstall' ? 'fsm_deinstall' : 'ship_back',
        describe: (siteName) => `Customer return request from ${siteName}`,
    })
    if (!outcome.raised) {
        if (outcome.reason === 'forbidden') return reply(response, 403, { error: outcome.why })
        if (outcome.reason === 'busy') return reply(response, 503, { error: outcome.why })
        if (outcome.reason === 'awaited') return reply(response, 409, { error: outcome.why })
        if (outcome.reason !== 'refused') return reply(response, 400, { error: outcome.why })
        return reply(response, 422, { error: 'Return not raised: the platform refused it' })
    }
    if (outcome.lines === 0) {
        return reply(response, 422, { error: 'No device could be added: each is already on a return or was refused' })
    }
    reply(response, 201, { returnOrder: outcome.number } satisfies ReturnRequestReceipt)
}
