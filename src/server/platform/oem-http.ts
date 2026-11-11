import { isSyncVendor, SYNC_MESSAGE, type SyncVendor } from '../domain/oem/adapters.ts'
import type { OemContext } from '../domain/oem/sync-adapters.ts'
import { PROPERTY, type PropertyOf } from '../domain/properties.ts'
import type { OemVendor } from '../domain/vocabulary.ts'
import { boolProperty, stringProperty } from './properties.ts'
import { restMessagePort } from './rest-messages.ts'

/** RESTMessageV2 transport for the OEM adapters (REST messages in fluent/oem/rest-messages.now.ts). */

/**
 * The switch of each vendor whose API the sync jobs read, and the organizations of those read per organization. Every
 * such vendor (domain/oem/adapters `SYNC_MESSAGE`) must have its switch, and neither table may name another vendor.
 */
const ENABLED: Record<SyncVendor, PropertyOf<boolean>> = PROPERTY.oemEnabled
const ORG_IDS: Partial<Record<SyncVendor, PropertyOf<string>>> = PROPERTY.oemOrgIds

type Holds<T extends true> = T
type _OnlySyncVendorsHaveASwitch = Holds<[keyof typeof PROPERTY.oemEnabled] extends [SyncVendor] ? true : false>
type _OnlySyncVendorsHaveOrgIds = Holds<[keyof typeof PROPERTY.oemOrgIds] extends [SyncVendor] ? true : false>

/** Whether `vendor`'s API is read: it has one, and its switch is on. */
export function oemEnabled(vendor: OemVendor): boolean {
    return isSyncVendor(vendor) && boolProperty(ENABLED[vendor])
}

/** The adapter context for calls served by `vendor`'s REST message. */
export function oemContext(vendor: SyncVendor): OemContext {
    const orgProperty = ORG_IDS[vendor]
    return {
        http: restMessagePort(SYNC_MESSAGE[vendor]),
        orgIds: orgProperty ? stringProperty(orgProperty).split(',').map((id) => id.trim()).filter(Boolean) : [],
    }
}
