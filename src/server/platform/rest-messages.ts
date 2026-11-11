import { RESTMessageV2 } from '@servicenow/glide/sn_ws'
import { messageOf } from '../domain/errors.ts'
import type { HttpPort, HttpResponse } from '../domain/http.ts'
import { PROPERTY, type PropertyOf } from '../domain/properties.ts'
import { REST_MESSAGE, type OemMessageName } from '../domain/rest-message-names.ts'
import { SHIPPING_MESSAGE } from '../domain/shipping.ts'
import { log } from './log.ts'
import { secretProperty, stringProperty } from './properties.ts'

/**
 * RESTMessageV2 transport behind the HttpPort seam (ADR 0008), with what each of the app's REST messages
 * (fluent/oem/rest-messages.now.ts and the shipping aggregator's) takes at call time besides a request's own parameters.
 */

/** The typings expose RESTMessageV2's Rhino constructor; at runtime it takes (message, function). */
const RestMessage = RESTMessageV2 as unknown as new (message: string, fn: string) => RESTMessageV2

/** A secret substituted into a REST message's headers (or login body) at call time, from a password2 property. */
interface SecretVariable {
    variable: string
    property: PropertyOf<string>
    /** Substituted inside a JSON body, so escaped as JSON string content. */
    inJson?: boolean
}

/**
 * A non-secret setting substituted at call time from a string property, trimmed but otherwise as it is (not
 * URL-encoded); its declared value applies when the property is empty or blank.
 */
interface SettingVariable {
    variable: string
    property: PropertyOf<string>
}

/** What a REST message takes at call time besides the request's own parameters. */
interface MessageVariables {
    secrets?: readonly SecretVariable[]
    settings?: readonly SettingVariable[]
}

/** A message that authenticates with an OAuth 2.0 profile attached to it on the instance takes no secret at call time. */
const OAUTH_PROFILE: MessageVariables = {}

type RestMessageName = OemMessageName | typeof SHIPPING_MESSAGE.name

/**
 * Secrets come from password2 properties. The API host variables sit in the host part of each function endpoint:
 * confirm on an instance that RESTMessageV2 substitutes ${} there, and fall back to rest.setEndpoint() with the host put
 * in if it does not.
 */
const VARIABLES: Record<RestMessageName, MessageVariables> = {
    [REST_MESSAGE.ciscoSupport.name]: OAUTH_PROFILE,
    [REST_MESSAGE.meraki.name]: {
        secrets: [{ variable: 'api_key', property: PROPERTY.merakiApiKey }],
        settings: [{ variable: 'meraki_host', property: PROPERTY.merakiApiHost }],
    },
    [REST_MESSAGE.fortiCare.name]: OAUTH_PROFILE,
    [REST_MESSAGE.mist.name]: {
        secrets: [{ variable: 'api_token', property: PROPERTY.mistApiToken }],
        settings: [{ variable: 'mist_host', property: PROPERTY.mistApiHost }],
    },
    [REST_MESSAGE.greenLake.name]: OAUTH_PROFILE,
    [REST_MESSAGE.fortiZtp.name]: OAUTH_PROFILE,
    [REST_MESSAGE.checkPoint.name]: {
        // Both go into the JSON login body.
        secrets: [
            { variable: 'api_client_id', property: PROPERTY.checkpointApiClientId, inJson: true },
            { variable: 'api_key', property: PROPERTY.checkpointApiKey, inJson: true },
        ],
    },
    [SHIPPING_MESSAGE.name]: { secrets: [{ variable: 'api_key', property: PROPERTY.shippingApiKey }] },
}

/**
 * Calls functions of the REST message `message`, with its secrets and settings. A call that gets no answer comes back
 * as status 0 with the reason in `error`, logged: one that throws, and one RESTMessageV2 answers with status 0, as it
 * does for a timeout or a DNS, TLS or connection failure, with the reason in getErrorMessage() and no body.
 */
export function restMessagePort(message: RestMessageName): HttpPort {
    const secrets = VARIABLES[message].secrets ?? []
    const settings = VARIABLES[message].settings ?? []
    return (request) => {
        try {
            const rest = new RestMessage(message, request.fn)
            for (const [name, value] of Object.entries(request.params)) rest.setStringParameterNoEscape(name, encodeURIComponent(value).replace(/%2C/g, ','))
            for (const [name, value] of Object.entries(request.headers ?? {})) rest.setRequestHeader(name, value)
            for (const setting of settings) rest.setStringParameterNoEscape(setting.variable, stringProperty(setting.property))
            for (const secret of secrets) {
                const value = secretProperty(secret.property)
                rest.setStringParameterNoEscape(secret.variable, secret.inJson ? JSON.stringify(value).slice(1, -1) : value)
            }
            if (request.body !== undefined) rest.setRequestBody(request.body)
            const response = rest.execute()
            const status = Number(response.getStatusCode())
            if (status === 0) return noAnswer(message, request.fn, String(response.getErrorMessage() || 'no reason given'))
            // Typed as a string, but null when no body came.
            const body: string | null = response.getBody()
            return { status, body: body === null || body === undefined ? '' : String(body) }
        } catch (error) {
            return noAnswer(message, request.fn, messageOf(error))
        }
    }
}

/** A call of `message`.`fn` that got no answer, logged with its reason. */
function noAnswer(message: string, fn: string, error: string): HttpResponse {
    log.warn(`${message}.${fn} failed: ${error}`)
    return { status: 0, body: '', error }
}
