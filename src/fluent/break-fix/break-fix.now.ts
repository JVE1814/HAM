import '@servicenow/sdk/global'
import {
    Acl,
    BooleanColumn,
    BusinessRule,
    ChoiceColumn,
    DateColumn,
    DateTimeColumn,
    default_view,
    Form,
    List,
    Record,
    ReferenceColumn,
    ScriptAction,
    Sla,
    StringColumn,
    Table,
    UiAction,
} from '@servicenow/sdk/core'
import { OEM_VENDOR_CHOICES, ORDER_STAGE, REPLACEMENT_TIER, RMA_STATE, RMA_STATE_CHOICES } from '../../server/domain/vocabulary'
import { FLEET_CONDITION } from '../../server/domain/fleet'
import { onCaseFailedAsset, uiDefectiveReturnedToOem, uiRaiseReplacement } from '../../server/entry/breakfix'
import { PLATFORM_ROLE } from '../../server/domain/visibility'
import { EVENT } from '../../server/platform/events'
import { onReplacementComplete } from '../../server/entry/replacements'
import { admin, assetManager, noc, providerStaff, returnWorkers, stockroomWorkers } from '../shared/roles.now'
import { naasMenu } from '../shared/menu.now'

/** The replacement SLAs stop once the case's replacement Order is complete, and are cancelled when the case closes without that. */
const REPLACEMENT_COMPLETE = `x_daas_ham_replacement_order.stage=${ORDER_STAGE.complete}`
const CASE_CLOSED_UNREPLACED = `active=false^x_daas_ham_replacement_order.stage!=${ORDER_STAGE.complete}`

/* Break-fix (P2.3, D58): OEM RMAs, the replacement of a failed Asset and its SLAs. */

/** A return authorisation opened with the manufacturer for a defective Asset. */
export const x_daas_ham_oem_rma = Table({
    name: 'x_daas_ham_oem_rma',
    label: 'OEM RMA',
    display: 'rma_number',
    schema: {
        vendor: ChoiceColumn({ label: 'Vendor', choices: OEM_VENDOR_CHOICES, mandatory: true }),
        rma_number: StringColumn({ label: 'RMA number', maxLength: 60 }),
        defective_asset: ReferenceColumn({
            label: 'Defective asset',
            referenceTable: 'alm_hardware',
            mandatory: true,
            referenceQual: FLEET_CONDITION,
        }),
        order_line: ReferenceColumn({ label: 'Replacement order line', referenceTable: 'x_daas_ham_order_line' }),
        case: ReferenceColumn({ label: 'Case', referenceTable: 'sn_customerservice_case' }),
        advance_replacement: BooleanColumn({ label: 'OEM advance replacement', default: true }),
        replacement_serial: StringColumn({ label: 'Replacement serial', maxLength: 100 }),
        status: StringColumn({ label: 'OEM status', maxLength: 100 }),
        state: ChoiceColumn({
            label: 'State',
            choices: RMA_STATE_CHOICES,
            default: 'to_open',
            dropdown: 'dropdown_without_none',
        }),
        ship_back_due: DateColumn({ label: 'Return defective by' }),
        last_synced: DateTimeColumn({ label: 'Last checked', readOnly: true }),
    },
    index: [{ name: 'x_daas_ham_rma_number', unique: false, element: 'rma_number' }],
})

BusinessRule({
    $id: Now.ID['br_case_failed_asset'],
    name: 'NaaS - case failed asset service level',
    table: 'sn_customerservice_case',
    when: 'before',
    action: ['insert', 'update'],
    order: 100,
    condition: "current.x_daas_ham_failed_asset.changes() && current.x_daas_ham_failed_asset != ''",
    script: onCaseFailedAsset,
})

UiAction({
    $id: Now.ID['ua_case_raise_replacement'],
    name: 'Raise replacement',
    table: 'sn_customerservice_case',
    actionName: 'x_daas_ham_raise_replacement',
    hint: 'Order a like-for-like replacement of the failed asset (spare at the site, spare pool, stock, OEM advance replacement or purchase).',
    // Offered while no replacement goes ahead: none linked, or the linked one ended unfulfilled (domain/breakfix
    // replacementStep, which built-metadata.test.ts holds the built condition to).
    condition:
        `current.x_daas_ham_failed_asset != '' && current.active == true && (current.x_daas_ham_replacement_order == '' || ['${ORDER_STAGE.rejected}', '${ORDER_STAGE.cancelled}'].indexOf(String(current.x_daas_ham_replacement_order.stage)) >= 0)`,
    roles: [noc, assetManager, PLATFORM_ROLE.serviceDeskAgent],
    form: { showButton: true, style: 'primary' },
    showUpdate: true,
    script: uiRaiseReplacement,
})

UiAction({
    $id: Now.ID['ua_rma_defective_returned'],
    name: 'Defective returned to OEM',
    table: 'x_daas_ham_oem_rma',
    actionName: 'x_daas_ham_rma_defective_returned',
    hint: 'Record that the defective unit was shipped back to the manufacturer (needs wipe evidence on the asset).',
    // domain/oem-rma RMA_AT_OEM, which built-metadata.test.ts holds the built condition to.
    condition: `['${RMA_STATE.open}','${RMA_STATE.replacement_received}'].indexOf(current.state + '') >= 0`,
    roles: stockroomWorkers,
    form: { showButton: true },
    showUpdate: true,
    script: uiDefectiveReturnedToOem,
})

// The SLA engine weighs a case's SLAs only when the case is saved, so the Order's completion queues
// x_daas_ham.replacement.complete (platform/fulfilment recomputeOrder), whose script action saves the case with a work
// note. It runs as system, outside the interactive session that completed the Order, where Customer Service's case query
// rules could hide the case.
Record({
    $id: Now.ID['event_replacement_complete'],
    table: 'sysevent_register',
    data: {
        suffix: 'replacement.complete',
        event_name: EVENT.replacementComplete,
        table: 'x_daas_ham_order',
        description: 'A replacement Order is complete: its case is saved, so that its replacement SLA stops.',
        priority: 100,
    },
})

ScriptAction({
    $id: Now.ID['sa_replacement_complete'],
    name: 'NaaS - note replacement on its case',
    eventName: EVENT.replacementComplete,
    active: true,
    script: onReplacementComplete,
    description: "Saves a completed replacement Order's open case with a work note, so the SLA engine stops its replacement SLA.",
})

Sla({
    $id: Now.ID['sla_replace_nbd'],
    name: 'NaaS replacement - next business day',
    table: 'sn_customerservice_case',
    target: 'resolution',
    duration: Duration({ days: 1 }),
    scheduleSource: 'no_schedule',
    conditions: {
        start: `x_daas_ham_failed_assetISNOTEMPTY^x_daas_ham_replacement_tier=${REPLACEMENT_TIER.nbd}`,
        stop: REPLACEMENT_COMPLETE,
        cancel: CASE_CLOSED_UNREPLACED,
    },
})

Sla({
    $id: Now.ID['sla_replace_same_day'],
    name: 'NaaS replacement - same day (8 hours)',
    table: 'sn_customerservice_case',
    target: 'resolution',
    duration: Duration({ hours: 8 }),
    scheduleSource: 'no_schedule',
    conditions: {
        start: `x_daas_ham_failed_assetISNOTEMPTY^x_daas_ham_replacement_tier=${REPLACEMENT_TIER.same_day}`,
        stop: REPLACEMENT_COMPLETE,
        cancel: CASE_CLOSED_UNREPLACED,
    },
})

Sla({
    $id: Now.ID['sla_replace_four_hour'],
    name: 'NaaS replacement - 24x7x4',
    table: 'sn_customerservice_case',
    target: 'resolution',
    duration: Duration({ hours: 4 }),
    scheduleSource: 'no_schedule',
    conditions: {
        start: `x_daas_ham_failed_assetISNOTEMPTY^x_daas_ham_replacement_tier=${REPLACEMENT_TIER.four_hour}`,
        stop: REPLACEMENT_COMPLETE,
        cancel: CASE_CLOSED_UNREPLACED,
    },
})

Acl({
    $id: Now.ID['acl_oem_rma_read'],
    type: 'record',
    table: 'x_daas_ham_oem_rma',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_oem_rma_create'],
    type: 'record',
    table: 'x_daas_ham_oem_rma',
    operation: 'create',
    roles: returnWorkers,
})

Acl({
    $id: Now.ID['acl_oem_rma_write'],
    type: 'record',
    table: 'x_daas_ham_oem_rma',
    operation: 'write',
    roles: returnWorkers,
})

Acl({
    $id: Now.ID['acl_oem_rma_delete'],
    type: 'record',
    table: 'x_daas_ham_oem_rma',
    operation: 'delete',
    roles: [admin],
})

Form({
    table: 'x_daas_ham_oem_rma',
    view: default_view,
    sections: [
        {
            caption: 'RMA',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'rma_number', type: 'table_field' }, { field: 'vendor', type: 'table_field' }, { field: 'state', type: 'table_field' }, { field: 'status', type: 'table_field' }, { field: 'advance_replacement', type: 'table_field' }],
                    rightElements: [{ field: 'defective_asset', type: 'table_field' }, { field: 'order_line', type: 'table_field' }, { field: 'case', type: 'table_field' }, { field: 'replacement_serial', type: 'table_field' }, { field: 'ship_back_due', type: 'table_field' }, { field: 'last_synced', type: 'table_field' }],
                },
            ],
        },
    ],
})

List({ table: 'x_daas_ham_oem_rma', view: default_view, columns: ['rma_number', 'vendor', 'state', 'status', 'defective_asset', 'replacement_serial', 'ship_back_due'] })

Record({
    $id: Now.ID['module_oem_rmas'],
    table: 'sys_app_module',
    data: {
        title: 'OEM RMAs',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_oem_rma',
        roles: providerStaff,
        active: true,
        order: 360,
    },
})
