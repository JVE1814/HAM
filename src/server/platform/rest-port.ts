import { gs } from '@servicenow/glide'
import { RESTMessageV2 } from '@servicenow/glide/sn_ws'
import { messageOf } from '../domain/errors.ts'
import type { HttpPort, HttpResponse } from '../domain/http.ts'
import { type PropertyOf } from '../domain/properties.ts'
import { secretProperty, stringProperty } from './properties.ts'

/**
 * RESTMessageV2 transport behind the HttpPort seam (ADR 0008). It knows no REST message of its own: what each of the
 * app's messages takes at call time is listed in platform/rest-messages.
 */

/** The typings expose RESTMessageV2's Rhino constructor; at runtime it takes (message, function). */
const RestMessage = RESTMessageV2 as unknown as new (message: string, fn: string) => RESTMessageV2

/** A secret substituted into a REST message's headers (or login body) at call time, from a password2 property. */
export interface SecretVariable {
    variable: string
    property: PropertyOf<string>
    /** Substituted inside a JSON body, so escaped as JSON string content. */
    inJson?: boolean
}

/**
 * A non-secret setting substituted at call time from a string property, trimmed but otherwise as it is (not
 * URL-encoded); its declared value applies when the property is empty or blank.
 */
export interface SettingVariable {
    variable: string
    property: PropertyOf<string>
}

/** What a REST message takes at call time besides the request's own parameters. */
export interface MessageVariables {
    secrets?: readonly SecretVariable[]
    settings?: readonly SettingVariable[]
}

/**
 * Calls functions of the REST message `message`, with its `variables`. A call that gets no answer comes back as status
 * 0 with the reason in `error`, logged: one that throws, and one RESTMessageV2 answers with status 0, as it does for a
 * timeout or a DNS, TLS or connection failure, with the reason in getErrorMessage() and no body.
 */
export function restPort(message: string, variables: MessageVariables): HttpPort {
    const secrets = variables.secrets ?? []
    const settings = variables.settings ?? []
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
    gs.warn(`[x_daas_ham] ${message}.${fn} failed: ${error}`)
    return { status: 0, body: '', error }
}
