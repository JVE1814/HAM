import { gs } from '@servicenow/glide'
import { RESTMessageV2 } from '@servicenow/glide/sn_ws'
import type { OemContext } from '../domain/oem/adapters'
import type { HttpPort, OemVendor } from '../domain/oem/types'
import { boolProperty, stringProperty } from './properties'

/** RESTMessageV2 transport for the OEM adapters (REST messages in fluent/logic/oem-messages.now.ts). */

const MESSAGE: Partial<Record<OemVendor, string>> = {
    cisco: 'NaaS Cisco Support',
    meraki: 'NaaS Meraki Dashboard',
    fortinet: 'NaaS FortiCare',
    mist: 'NaaS HPE Mist',
}

/** The typings expose RESTMessageV2's Rhino constructor; at runtime it takes (message, function). */
const RestMessage = RESTMessageV2 as unknown as new (message: string, fn: string) => RESTMessageV2

/** Secrets substituted into headers at call time (password2 properties). */
const SECRET: Partial<Record<OemVendor, { variable: string; property: string }>> = {
    meraki: { variable: 'api_key', property: 'x_daas_ham.meraki.api_key' },
    mist: { variable: 'api_token', property: 'x_daas_ham.mist.api_token' },
}

const ORG_IDS: Partial<Record<OemVendor, string>> = {
    meraki: 'x_daas_ham.meraki.org_ids',
    mist: 'x_daas_ham.mist.org_ids',
}

export function oemEnabled(vendor: OemVendor): boolean {
    return !!MESSAGE[vendor] && boolProperty(`x_daas_ham.oem.${vendor}.enabled`, false)
}

function httpPort(vendor: OemVendor): HttpPort {
    return (request) => {
        try {
            const message = new RestMessage(MESSAGE[vendor] ?? '', request.fn)
            for (const [name, value] of Object.entries(request.params)) message.setStringParameterNoEscape(name, encodeURIComponent(value).replace(/%2C/g, ','))
            const secret = SECRET[vendor]
            if (secret) message.setStringParameterNoEscape(secret.variable, gs.getPropertySecured(secret.property, ''))
            const response = message.execute()
            return { status: response.getStatusCode(), body: response.getBody() }
        } catch (error) {
            gs.warn(`[x_daas_ham] OEM ${vendor}.${request.fn} failed: ${error instanceof Error ? error.message : String(error)}`)
            return { status: 0, body: '' }
        }
    }
}

/** The adapter context for calls served by `vendor`'s REST message. */
export function oemContext(vendor: OemVendor): OemContext {
    const orgProperty = ORG_IDS[vendor]
    return {
        http: httpPort(vendor),
        orgIds: orgProperty ? stringProperty(orgProperty).split(',').map((id) => id.trim()).filter(Boolean) : [],
    }
}
