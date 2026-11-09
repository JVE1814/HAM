import '@servicenow/sdk/global'
import { Record } from '@servicenow/sdk/core'
import { STAGE_FIELDS } from '../../server/domain/vocabulary'

/*
 * Substatus values this app adds to alm_asset.substatus (ADR 0002). The SDK refuses ChoiceSet on
 * global tables from a scoped app, so each value ships as a sys_choice record: one per Lifecycle stage
 * whose STAGE_FIELDS entry carries a `choice`, every value read from that entry. Fluent has no loops,
 * so a stage given a `choice` there needs its Record here (substatus-choices.test.ts compares the
 * built set with STAGE_FIELDS).
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
        value: STAGE_FIELDS.spare_pool.substatus,
        label: STAGE_FIELDS.spare_pool.choice.label,
        dependent_value: STAGE_FIELDS.spare_pool.installStatus,
        sequence: STAGE_FIELDS.spare_pool.choice.sequence,
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
        value: STAGE_FIELDS.staging.substatus,
        label: STAGE_FIELDS.staging.choice.label,
        dependent_value: STAGE_FIELDS.staging.installStatus,
        sequence: STAGE_FIELDS.staging.choice.sequence,
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
        value: STAGE_FIELDS.staged.substatus,
        label: STAGE_FIELDS.staged.choice.label,
        dependent_value: STAGE_FIELDS.staged.installStatus,
        sequence: STAGE_FIELDS.staged.choice.sequence,
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
        value: STAGE_FIELDS.shipped.substatus,
        label: STAGE_FIELDS.shipped.choice.label,
        dependent_value: STAGE_FIELDS.shipped.installStatus,
        sequence: STAGE_FIELDS.shipped.choice.sequence,
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
        value: STAGE_FIELDS.pending_in_service.substatus,
        label: STAGE_FIELDS.pending_in_service.choice.label,
        dependent_value: STAGE_FIELDS.pending_in_service.installStatus,
        sequence: STAGE_FIELDS.pending_in_service.choice.sequence,
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
        value: STAGE_FIELDS.temporary_deployment.substatus,
        label: STAGE_FIELDS.temporary_deployment.choice.label,
        dependent_value: STAGE_FIELDS.temporary_deployment.installStatus,
        sequence: STAGE_FIELDS.temporary_deployment.choice.sequence,
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
        value: STAGE_FIELDS.pending_return.substatus,
        label: STAGE_FIELDS.pending_return.choice.label,
        dependent_value: STAGE_FIELDS.pending_return.installStatus,
        sequence: STAGE_FIELDS.pending_return.choice.sequence,
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
        value: STAGE_FIELDS.pending_oem_rma.substatus,
        label: STAGE_FIELDS.pending_oem_rma.choice.label,
        dependent_value: STAGE_FIELDS.pending_oem_rma.installStatus,
        sequence: STAGE_FIELDS.pending_oem_rma.choice.sequence,
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
        value: STAGE_FIELDS.pending_wipe.substatus,
        label: STAGE_FIELDS.pending_wipe.choice.label,
        dependent_value: STAGE_FIELDS.pending_wipe.installStatus,
        sequence: STAGE_FIELDS.pending_wipe.choice.sequence,
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
        value: STAGE_FIELDS.returned_to_customer.substatus,
        label: STAGE_FIELDS.returned_to_customer.choice.label,
        dependent_value: STAGE_FIELDS.returned_to_customer.installStatus,
        sequence: STAGE_FIELDS.returned_to_customer.choice.sequence,
        language: 'en',
        inactive: false,
    },
})
