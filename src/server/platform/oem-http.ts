import type { OemContext } from '../domain/oem/adapters'
import type { OemVendor } from '../domain/oem/types'
import { boolProperty, stringProperty } from './properties'
import { restMessagePort, type SecretVariable } from './rest-port'

/** RESTMessageV2 transport for the OEM adapters (REST messages in fluent/logic/oem-messages.now.ts). */

const MESSAGE: Partial<Record<OemVendor, string>> = {
    cisco: 'NaaS Cisco Support',
    meraki: 'NaaS Meraki Dashboard',
    fortinet: 'NaaS FortiCare',
    mist: 'NaaS HPE Mist',
}

/** Secrets substituted into headers at call time (password2 properties). */
const SECRET: Partial<Record<OemVendor, SecretVariable>> = {
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

/** The adapter context for calls served by `vendor`'s REST message. */
export function oemContext(vendor: OemVendor): OemContext {
    const orgProperty = ORG_IDS[vendor]
    return {
        http: restMessagePort(MESSAGE[vendor] ?? '', SECRET[vendor] ? [SECRET[vendor]] : []),
        orgIds: orgProperty ? stringProperty(orgProperty).split(',').map((id) => id.trim()).filter(Boolean) : [],
    }
}
