import type { OemContext } from '../domain/oem/adapters.ts'
import type { OemVendor } from '../domain/vocabulary.ts'
import { boolProperty, PROPERTY, stringProperty, type PropertyOf } from './properties.ts'
import { restMessagePort } from './rest-messages.ts'

/** RESTMessageV2 transport for the OEM adapters (REST messages in fluent/logic/oem-messages.now.ts). */

/** The message serving each vendor's lifecycle / coverage / RMA data. */
const MESSAGE: Partial<Record<OemVendor, string>> = {
    cisco: 'NaaS Cisco Support',
    meraki: 'NaaS Meraki Dashboard',
    fortinet: 'NaaS FortiCare',
    mist: 'NaaS HPE Mist',
}

const ENABLED: Partial<Record<OemVendor, PropertyOf<boolean>>> = PROPERTY.oemEnabled
const ORG_IDS: Partial<Record<OemVendor, PropertyOf<string>>> = PROPERTY.oemOrgIds

export function oemEnabled(vendor: OemVendor): boolean {
    const enabled = ENABLED[vendor]
    return !!MESSAGE[vendor] && !!enabled && boolProperty(enabled)
}

/** The adapter context for calls served by `vendor`'s REST message. */
export function oemContext(vendor: OemVendor): OemContext {
    const orgProperty = ORG_IDS[vendor]
    return {
        http: restMessagePort(MESSAGE[vendor] ?? ''),
        orgIds: orgProperty ? stringProperty(orgProperty).split(',').map((id) => id.trim()).filter(Boolean) : [],
    }
}
