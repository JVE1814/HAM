import '@servicenow/sdk/global'
import { UiAction } from '@servicenow/sdk/core'
import { uiAddToFleet } from '../../server/entry/fleet'
import { admin, assetManager } from '../security/roles.now'

/*
 * Adopting the Provider's existing equipment into the fleet (ADR 0016). The Fleet flag is read-only on forms, so this
 * action, and the app's own intake paths, are the only ways in. Offered on an Asset not yet in the fleet: one blank
 * (from before the column) as well as false.
 */
UiAction({
    $id: Now.ID['ua_asset_add_to_fleet'],
    name: 'Add to fleet',
    table: 'alm_hardware',
    actionName: 'x_daas_ham_add_to_fleet',
    hint: 'Make this asset part of the NaaS fleet, so NaaS asset management sources, stages, tracks and bills it.',
    condition: 'current.x_daas_ham_fleet != true',
    roles: [assetManager, admin],
    form: { showButton: true },
    list: { showListChoice: true },
    // An Asset is adopted once saved: a new one the app creates is a fleet asset already (platform/assets newAsset).
    showInsert: false,
    showUpdate: true,
    script: uiAddToFleet,
})
