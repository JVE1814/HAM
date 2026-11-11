import '@servicenow/sdk/global'
import { BusinessRule, Property, ScheduledScript, UiAction } from '@servicenow/sdk/core'
import { CURRENT_IS_FLEET, FLEET_FIELD } from '../../server/domain/fleet'
import {
    clearVoidedWipeEvidence,
    explainLifecycleRefusal,
    onAllocatedAssetStageChange,
    onAssetServiceChange,
    onTransferReleased,
} from '../../server/entry/assets'
import { uiAddToFleet } from '../../server/entry/fleet'
import { topUpSparePools } from '../../server/entry/spare-pool'
import { PROPERTY } from '../../server/platform/properties'
import { ENTRY_MODULES } from '../shared/server-modules.now'
import { admin, assetManager } from '../shared/roles.now'

/* Record-change rules on fleet assets, which drive the Order lifecycle (ADR 0004). */

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

/** A fleet asset changed its stage: the change test and the Fleet flag every stage rule on alm_hardware starts with. */
const FLEET_ASSET_STAGE_CHANGED = `(current.install_status.changes() || current.substatus.changes()) && ${CURRENT_IS_FLEET}`

// Ahead of the lifecycle rule, so that it checks the stage the Asset takes back, not Inventory's In stock / Available.
BusinessRule({
    $id: Now.ID['br_asset_transfer_released'],
    name: 'NaaS - asset stage back after transfer',
    table: 'alm_hardware',
    when: 'before',
    action: ['update'],
    order: 80,
    condition: `current.active_to.changes() && ${CURRENT_IS_FLEET}`,
    script: onTransferReleased,
})

BusinessRule({
    $id: Now.ID['br_asset_enforce_lifecycle'],
    name: 'NaaS - enforce asset lifecycle',
    table: 'alm_hardware',
    when: 'before',
    action: ['update'],
    order: 100,
    condition:
`${FLEET_ASSET_STAGE_CHANGED} && require('${ENTRY_MODULES}/assets.ts').refusesLifecycleChange(current, previous)`,
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
    condition: FLEET_ASSET_STAGE_CHANGED,
    script: clearVoidedWipeEvidence,
})

// Also takes a unit that left its line in transit off it.
BusinessRule({
    $id: Now.ID['br_asset_stage_to_order_line'],
    name: 'NaaS - asset stage advances order line',
    table: 'alm_hardware',
    when: 'after',
    action: ['update'],
    order: 200,
    condition: `${FLEET_ASSET_STAGE_CHANGED} && current.x_daas_ham_order_line != ''`,
    script: onAllocatedAssetStageChange,
})

BusinessRule({
    $id: Now.ID['br_asset_left_service'],
    name: 'NaaS - start or stop billing on service',
    table: 'alm_hardware',
    when: 'after',
    action: ['update'],
    order: 210,
    condition: FLEET_ASSET_STAGE_CHANGED,
    script: onAssetServiceChange,
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

ScheduledScript({
    $id: Now.ID['job_spare_pool_top_up'],
    name: 'NaaS - spare pool top-up',
    active: true,
    frequency: 'daily',
    executionTime: { hours: 2, minutes: 40, seconds: 0 },
    timeZone: 'UTC',
    script: topUpSparePools,
})

Property({
    $id: Now.ID['prop_spare_auto_purchase'],
    name: PROPERTY.autoPurchaseSpares.name,
    type: 'boolean',
    value: PROPERTY.autoPurchaseSpares.default,
    description: 'When true, the spare-pool top-up job requests purchase orders for shortfalls central stock cannot cover.',
    roles: { read: [admin], write: [admin] },
})
