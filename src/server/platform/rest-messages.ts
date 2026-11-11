import type { HttpPort } from '../domain/http.ts'
import { PROPERTY } from './properties.ts'
import { restPort, type MessageVariables } from './rest-port.ts'
import { REST_MESSAGE } from '../domain/rest-message-names.ts'

/**
 * What each REST message of the app (fluent/oem/rest-messages.now.ts and the shipping aggregator's) takes at call
 * time besides a request's own parameters: its secrets and its settings.
 */

/**
 * Secrets come from password2 properties. A message with none authenticates with an OAuth 2.0 profile attached on the
 * instance. The API host variables sit in the host part of each function endpoint: confirm on an instance that
 * RESTMessageV2 substitutes ${} there, and fall back to rest.setEndpoint() with the host put in if it does not.
 */
const VARIABLES: Record<string, MessageVariables> = {
    [REST_MESSAGE.meraki.name]: {
        secrets: [{ variable: 'api_key', property: PROPERTY.merakiApiKey }],
        settings: [{ variable: 'meraki_host', property: PROPERTY.merakiApiHost }],
    },
    [REST_MESSAGE.mist.name]: {
        secrets: [{ variable: 'api_token', property: PROPERTY.mistApiToken }],
        settings: [{ variable: 'mist_host', property: PROPERTY.mistApiHost }],
    },
    [REST_MESSAGE.checkPoint.name]: {
        // Both go into the JSON login body.
        secrets: [
            { variable: 'api_client_id', property: PROPERTY.checkpointApiClientId, inJson: true },
            { variable: 'api_key', property: PROPERTY.checkpointApiKey, inJson: true },
        ],
    },
    [REST_MESSAGE.shipping.name]: { secrets: [{ variable: 'api_key', property: PROPERTY.shippingApiKey }] },
}

/** Calls functions of the REST message `message`, with its secrets and settings (platform/rest-port). */
export function restMessagePort(message: string): HttpPort {
    return restPort(message, VARIABLES[message] ?? {})
}
