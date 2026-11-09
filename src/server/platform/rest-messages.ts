import type { HttpPort } from '../domain/http.ts'
import { restPort, type MessageVariables } from './rest-port.ts'

/**
 * What each REST message of the app (fluent/logic/oem-messages.now.ts and the shipping aggregator's) takes at call
 * time besides a request's own parameters: its secrets and its settings.
 */

/**
 * Secrets come from password2 properties. A message with none authenticates with an OAuth 2.0 profile attached on the
 * instance. The API host variables sit in the host part of each function endpoint: confirm on an instance that
 * RESTMessageV2 substitutes ${} there, and fall back to rest.setEndpoint() with the host put in if it does not.
 */
const VARIABLES: Record<string, MessageVariables> = {
    'NaaS Meraki Dashboard': {
        secrets: [{ variable: 'api_key', property: 'x_daas_ham.meraki.api_key' }],
        settings: [{ variable: 'meraki_host', property: 'x_daas_ham.meraki.api_host', fallback: 'api.meraki.com' }],
    },
    'NaaS HPE Mist': {
        secrets: [{ variable: 'api_token', property: 'x_daas_ham.mist.api_token' }],
        settings: [{ variable: 'mist_host', property: 'x_daas_ham.mist.api_host', fallback: 'api.mist.com' }],
    },
    'NaaS Check Point Zero Touch': {
        // Both go into the JSON login body.
        secrets: [
            { variable: 'api_client_id', property: 'x_daas_ham.checkpoint.api_client_id', inJson: true },
            { variable: 'api_key', property: 'x_daas_ham.checkpoint.api_key', inJson: true },
        ],
    },
    'NaaS Shipping aggregator': { secrets: [{ variable: 'api_key', property: 'x_daas_ham.shipping.api_key' }] },
}

/** Calls functions of the REST message `message`, with its secrets and settings (platform/rest-port). */
export function restMessagePort(message: string): HttpPort {
    return restPort(message, VARIABLES[message] ?? {})
}
