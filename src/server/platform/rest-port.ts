import { gs } from '@servicenow/glide'
import { RESTMessageV2 } from '@servicenow/glide/sn_ws'
import type { HttpPort } from '../domain/http'
import { stringProperty } from './properties'

/** RESTMessageV2 transport behind the HttpPort seam (ADR 0008). */

/** The typings expose RESTMessageV2's Rhino constructor; at runtime it takes (message, function). */
const RestMessage = RESTMessageV2 as unknown as new (message: string, fn: string) => RESTMessageV2

/**
 * Secrets substituted into each REST message's headers (or login body) at call time, from password2
 * properties. Messages not listed authenticate with an OAuth 2.0 profile attached on the instance.
 */
const SECRETS: Record<string, Array<{ variable: string; property: string; inJson?: boolean }>> = {
    'NaaS Meraki Dashboard': [{ variable: 'api_key', property: 'x_daas_ham.meraki.api_key' }],
    'NaaS HPE Mist': [{ variable: 'api_token', property: 'x_daas_ham.mist.api_token' }],
    'NaaS Check Point Zero Touch': [
        // Substituted inside the JSON login body, so escaped as JSON string content.
        { variable: 'api_client_id', property: 'x_daas_ham.checkpoint.api_client_id', inJson: true },
        { variable: 'api_key', property: 'x_daas_ham.checkpoint.api_key', inJson: true },
    ],
    'NaaS Shipping aggregator': [{ variable: 'api_key', property: 'x_daas_ham.shipping.api_key' }],
}

/**
 * Non-secret settings substituted at call time from string properties, trimmed but otherwise as they
 * are (not URL-encoded); `fallback` applies when the property is empty or blank. The API host
 * variables sit in the host part of each function endpoint: confirm on an instance that RESTMessageV2
 * substitutes ${} there, and fall back to rest.setEndpoint() with the host put in if it does not.
 */
const SETTINGS: Record<string, Array<{ variable: string; property: string; fallback: string }>> = {
    'NaaS Meraki Dashboard': [{ variable: 'meraki_host', property: 'x_daas_ham.meraki.api_host', fallback: 'api.meraki.com' }],
    'NaaS HPE Mist': [{ variable: 'mist_host', property: 'x_daas_ham.mist.api_host', fallback: 'api.mist.com' }],
}

/** Calls functions of the REST message `message` (with its secrets and settings); failures come back as status 0. */
export function restMessagePort(message: string): HttpPort {
    const secrets = SECRETS[message] ?? []
    const settings = SETTINGS[message] ?? []
    return (request) => {
        try {
            const rest = new RestMessage(message, request.fn)
            for (const [name, value] of Object.entries(request.params)) rest.setStringParameterNoEscape(name, encodeURIComponent(value).replace(/%2C/g, ','))
            for (const [name, value] of Object.entries(request.headers ?? {})) rest.setRequestHeader(name, value)
            for (const setting of settings) rest.setStringParameterNoEscape(setting.variable, stringProperty(setting.property, setting.fallback))
            for (const secret of secrets) {
                const value = gs.getPropertySecured(secret.property, '')
                rest.setStringParameterNoEscape(secret.variable, secret.inJson ? JSON.stringify(value).slice(1, -1) : value)
            }
            if (request.body !== undefined) rest.setRequestBody(request.body)
            const response = rest.execute()
            return { status: response.getStatusCode(), body: response.getBody() }
        } catch (error) {
            gs.warn(`[x_daas_ham] ${message}.${request.fn} failed: ${error instanceof Error ? error.message : String(error)}`)
            return { status: 0, body: '' }
        }
    }
}
