import { gs } from '@servicenow/glide'
import { RESTMessageV2 } from '@servicenow/glide/sn_ws'
import type { HttpPort } from '../domain/http'

/** RESTMessageV2 transport behind the HttpPort seam (ADR 0008). */

/** The typings expose RESTMessageV2's Rhino constructor; at runtime it takes (message, function). */
const RestMessage = RESTMessageV2 as unknown as new (message: string, fn: string) => RESTMessageV2

/**
 * Secrets substituted into each REST message's headers at call time, from password2 properties.
 * Messages not listed authenticate with an OAuth 2.0 profile attached on the instance.
 */
const SECRETS: Record<string, Array<{ variable: string; property: string }>> = {
    'NaaS Meraki Dashboard': [{ variable: 'api_key', property: 'x_daas_ham.meraki.api_key' }],
    'NaaS HPE Mist': [{ variable: 'api_token', property: 'x_daas_ham.mist.api_token' }],
    'NaaS Check Point Zero Touch': [{ variable: 'api_key', property: 'x_daas_ham.checkpoint.api_key' }],
    'NaaS Shipping aggregator': [{ variable: 'api_key', property: 'x_daas_ham.shipping.api_key' }],
}

/** Calls functions of the REST message `message` (with its secrets); failures come back as status 0. */
export function restMessagePort(message: string): HttpPort {
    const secrets = SECRETS[message] ?? []
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
