import type { HttpPort } from '../domain/http'
import type { OemContext } from '../domain/oem/adapters'
import type { OemVendor } from '../domain/oem/types'
import { boolProperty, stringProperty } from './properties'
import { restMessagePort, type SecretVariable } from './rest-port'

/** RESTMessageV2 transport for the OEM adapters (REST messages in fluent/logic/oem-messages.now.ts). */

/** The message serving each vendor's lifecycle / coverage / RMA data. */
const MESSAGE: Partial<Record<OemVendor, string>> = {
    cisco: 'NaaS Cisco Support',
    meraki: 'NaaS Meraki Dashboard',
    fortinet: 'NaaS FortiCare',
    mist: 'NaaS HPE Mist',
}

/**
 * Secrets substituted into a message's headers at call time (password2 properties). Messages not
 * listed authenticate with an OAuth 2.0 profile attached on the instance.
 */
const SECRETS: Record<string, SecretVariable[]> = {
    'NaaS Meraki Dashboard': [{ variable: 'api_key', property: 'x_daas_ham.meraki.api_key' }],
    'NaaS HPE Mist': [{ variable: 'api_token', property: 'x_daas_ham.mist.api_token' }],
    'NaaS Check Point Zero Touch': [{ variable: 'api_key', property: 'x_daas_ham.checkpoint.api_key' }],
}

const ORG_IDS: Partial<Record<OemVendor, string>> = {
    meraki: 'x_daas_ham.meraki.org_ids',
    mist: 'x_daas_ham.mist.org_ids',
}

export function oemEnabled(vendor: OemVendor): boolean {
    return !!MESSAGE[vendor] && boolProperty(`x_daas_ham.oem.${vendor}.enabled`, false)
}

/** Transport for one OEM REST message, with its secrets. */
export function oemMessagePort(message: string): HttpPort {
    return restMessagePort(message, SECRETS[message] ?? [])
}

/** The adapter context for calls served by `vendor`'s REST message. */
export function oemContext(vendor: OemVendor): OemContext {
    const orgProperty = ORG_IDS[vendor]
    return {
        http: oemMessagePort(MESSAGE[vendor] ?? ''),
        orgIds: orgProperty ? stringProperty(orgProperty).split(',').map((id) => id.trim()).filter(Boolean) : [],
    }
}
