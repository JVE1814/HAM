import type { OemContext } from '../domain/oem/adapters.ts'
import type { OemVendor } from '../domain/vocabulary.ts'
import { boolProperty, stringProperty } from './properties.ts'
import { restMessagePort } from './rest-port.ts'

/** RESTMessageV2 transport for the OEM adapters (REST messages in fluent/logic/oem-messages.now.ts). */

/** The message serving each vendor's lifecycle / coverage / RMA data. */
const MESSAGE: Partial<Record<OemVendor, string>> = {
    cisco: 'NaaS Cisco Support',
    meraki: 'NaaS Meraki Dashboard',
    fortinet: 'NaaS FortiCare',
    mist: 'NaaS HPE Mist',
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
        http: restMessagePort(MESSAGE[vendor] ?? ''),
        orgIds: orgProperty ? stringProperty(orgProperty).split(',').map((id) => id.trim()).filter(Boolean) : [],
    }
}
