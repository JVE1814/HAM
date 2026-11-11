import '@servicenow/sdk/global'
import { BusinessRule, UiAction } from '@servicenow/sdk/core'
import { CURRENT_FLEET_STAGE_CHANGED, FLEET_FIELD } from '../../server/domain/fleet'
import { clearVoidedWipeEvidence, explainLifecycleRefusal } from '../../server/entry/assets'
import { uiAddToFleet } from '../../server/entry/fleet'
import { ENTRY_MODULES } from '../shared/server-modules.now'
import { admin, assetManager } from '../shared/roles.now'

/* The lifecycle rules on fleet assets' stage changes, and adoption into the fleet. */

/*
 * alm_hardware is a global table: the platform refuses current.setAbortAction from this scope on its records and saves
 * anyway. So a before rule there refuses with its Abort action when its condition (the module's check) holds, and its
 * script only says why. The platform runs a condition on every save of the table, whether or not the rule's filter
 * matches, so each condition starts with its change test: the module loads only when that holds. The condition field
 * holds at most 254 characters.
 *
 * alm_hardware also holds the Provider IT's own equipment, which the app leaves alone (ADR 0016): each rule on it
 * tests the Fleet flag right after its change test, before anything else it checks or loads.
 */

BusinessRule({
    $id: Now.ID['br_asset_enforce_lifecycle'],
    name: 'NaaS - enforce asset lifecycle',
    table: 'alm_hardware',
    when: 'before',
    action: ['update'],
    order: 100,
    condition:
`${CURRENT_FLEET_STAGE_CHANGED} && require('${ENTRY_MODULES}/assets.ts').refusesLifecycleChange(current, previous)`,
    abortAction: true,
    script: explainLifecycleRefusal,
})

// Not part of the rule above, which runs its script only on a save it refuses: every save into staging, whoever makes
// it, clears the wipe evidence.
BusinessRule({
    $id: Now.ID['br_asset_staging_voids_wipe'],
    name: 'NaaS - staging voids wipe evidence',
    table: 'alm_hardware',
    when: 'before',
    action: ['update'],
    order: 100,
    condition: CURRENT_FLEET_STAGE_CHANGED,
    script: clearVoidedWipeEvidence,
})

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
    condition: `current.${FLEET_FIELD} != true`,
    roles: [assetManager, admin],
    form: { showButton: true },
    list: { showListChoice: true },
    // An Asset is adopted once saved: a new one the app creates is a fleet asset already (platform/assets newAsset).
    showInsert: false,
    showUpdate: true,
    script: uiAddToFleet,
})
