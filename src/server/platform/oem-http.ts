import type { SyncApi } from '../domain/oem/adapters.ts'
import type { OemContext } from '../domain/oem/sync-adapters.ts'
import { boolProperty, stringProperty } from './properties.ts'
import { restMessagePort } from './rest-messages.ts'

export function apiEnabled(api: SyncApi): boolean {
    return boolProperty(api.enabled)
}

export function oemContext(api: SyncApi): OemContext {
    return {
        http: restMessagePort(api.message),
        orgIds: api.orgIds ? stringProperty(api.orgIds).split(',').map((id) => id.trim()).filter(Boolean) : [],
    }
}
