import '@servicenow/sdk/global'
import { Record } from '@servicenow/sdk/core'

/*
 * Substatus values this app adds to alm_asset.substatus (ADR 0002). The SDK refuses ChoiceSet on
 * global tables from a scoped app, so each value ships as a sys_choice record. Keep in sync with
 * ADDED_SUBSTATUSES in src/server/domain/lifecycle.ts (enforced by substatus-choices.test.ts).
 *
 * All sys_choice records for one field share the update name sys_choice_alm_asset_substatus, so
 * without a parent only the last one survives the build. The sys_choice_set parent below groups
 * them into one choice-set update. Keep "legacyChoices": false in now.config.json: the v4
 * (sys_choice_v2) format deletes and re-inserts only these values, while the legacy v3 format
 * would delete every alm_asset.substatus choice, out-of-box ones included. Needs Brazil,
 * Australia Patch 4+ or Zurich Patch 11+.
 */

Record({
    $id: Now.ID['substatus_choice_set'],
    table: 'sys_choice_set',
    data: {
        name: 'alm_asset',
        element: 'substatus',
    },
})

Record({
    $id: Now.ID['substatus_reserved_spare_pool'],
    table: 'sys_choice',
    data: {
        name: 'alm_asset',
        element: 'substatus',
        value: 'reserved_spare_pool',
        label: 'Reserved - spare pool',
        dependent_value: '6',
        sequence: 500,
        language: 'en',
        inactive: false,
    },
})

Record({
    $id: Now.ID['substatus_staging'],
    table: 'sys_choice',
    data: {
        name: 'alm_asset',
        element: 'substatus',
        value: 'staging',
        label: 'Staging',
        dependent_value: '6',
        sequence: 510,
        language: 'en',
        inactive: false,
    },
})

Record({
    $id: Now.ID['substatus_staged'],
    table: 'sys_choice',
    data: {
        name: 'alm_asset',
        element: 'substatus',
        value: 'staged',
        label: 'Staged',
        dependent_value: '6',
        sequence: 520,
        language: 'en',
        inactive: false,
    },
})

Record({
    $id: Now.ID['substatus_shipped_to_site'],
    table: 'sys_choice',
    data: {
        name: 'alm_asset',
        element: 'substatus',
        value: 'shipped_to_site',
        label: 'Shipped to site',
        dependent_value: '9',
        sequence: 530,
        language: 'en',
        inactive: false,
    },
})

Record({
    $id: Now.ID['substatus_pending_in_service'],
    table: 'sys_choice',
    data: {
        name: 'alm_asset',
        element: 'substatus',
        value: 'pending_in_service',
        label: 'Pending in service',
        dependent_value: '1',
        sequence: 540,
        language: 'en',
        inactive: false,
    },
})

Record({
    $id: Now.ID['substatus_temporary_deployment'],
    table: 'sys_choice',
    data: {
        name: 'alm_asset',
        element: 'substatus',
        value: 'temporary_deployment',
        label: 'Temporary deployment',
        dependent_value: '1',
        sequence: 550,
        language: 'en',
        inactive: false,
    },
})

Record({
    $id: Now.ID['substatus_pending_return'],
    table: 'sys_choice',
    data: {
        name: 'alm_asset',
        element: 'substatus',
        value: 'pending_return',
        label: 'Pending return',
        dependent_value: '1',
        sequence: 560,
        language: 'en',
        inactive: false,
    },
})

Record({
    $id: Now.ID['substatus_pending_evaluation'],
    table: 'sys_choice',
    data: {
        name: 'alm_asset',
        element: 'substatus',
        value: 'pending_evaluation',
        label: 'Pending evaluation',
        dependent_value: '6',
        sequence: 570,
        language: 'en',
        inactive: false,
    },
})

Record({
    $id: Now.ID['substatus_pending_oem_rma'],
    table: 'sys_choice',
    data: {
        name: 'alm_asset',
        element: 'substatus',
        value: 'pending_oem_rma',
        label: 'Pending OEM RMA',
        dependent_value: '3',
        sequence: 580,
        language: 'en',
        inactive: false,
    },
})

Record({
    $id: Now.ID['substatus_pending_wipe'],
    table: 'sys_choice',
    data: {
        name: 'alm_asset',
        element: 'substatus',
        value: 'pending_wipe',
        label: 'Pending wipe',
        dependent_value: '6',
        sequence: 590,
        language: 'en',
        inactive: false,
    },
})

Record({
    $id: Now.ID['substatus_returned_to_customer'],
    table: 'sys_choice',
    data: {
        name: 'alm_asset',
        element: 'substatus',
        value: 'returned_to_customer',
        label: 'Returned to customer',
        dependent_value: '7',
        sequence: 600,
        language: 'en',
        inactive: false,
    },
})

Record({
    $id: Now.ID['substatus_returned_to_lessor'],
    table: 'sys_choice',
    data: {
        name: 'alm_asset',
        element: 'substatus',
        value: 'returned_to_lessor',
        label: 'Returned to lessor',
        dependent_value: '7',
        sequence: 610,
        language: 'en',
        inactive: false,
    },
})
