import { gs } from '@servicenow/glide'
import { RESTMessageV2 } from '@servicenow/glide/sn_ws'
import type { HttpPort } from '../domain/http'

/** RESTMessageV2 transport behind the HttpPort seam (ADR 0008). */

/** The typings expose RESTMessageV2's Rhino constructor; at runtime it takes (message, function). */
const RestMessage = RESTMessageV2 as unknown as new (message: string, fn: string) => RESTMessageV2

/** A secret substituted into the message at call time from a password2 property. */
export interface SecretVariable {
    variable: string
    property: string
}

/** Calls functions of the REST message `message`; failures come back as status 0. */
export function restMessagePort(message: string, secrets: readonly SecretVariable[] = []): HttpPort {
    return (request) => {
        try {
            const rest = new RestMessage(message, request.fn)
            for (const [name, value] of Object.entries(request.params)) rest.setStringParameterNoEscape(name, encodeURIComponent(value).replace(/%2C/g, ','))
            for (const secret of secrets) rest.setStringParameterNoEscape(secret.variable, gs.getPropertySecured(secret.property, ''))
            if (request.body !== undefined) rest.setRequestBody(request.body)
            const response = rest.execute()
            return { status: response.getStatusCode(), body: response.getBody() }
        } catch (error) {
            gs.warn(`[x_daas_ham] ${message}.${request.fn} failed: ${error instanceof Error ? error.message : String(error)}`)
            return { status: 0, body: '' }
        }
    }
}
