import '@servicenow/sdk/global'
import {
    Acl,
    BusinessRule,
    ChoiceColumn,
    DecimalColumn,
    default_view,
    Form,
    List,
    ListColumn,
    Record,
    ReferenceColumn,
    StringColumn,
    Table,
    UiAction,
} from '@servicenow/sdk/core'
import { DISPOSAL_LINE_STATUS, DISPOSAL_LINE_STATUS_CHOICES, DISPOSAL_METHOD_CHOICES, DISPOSAL_STAGE, DISPOSAL_STAGE_CHOICES } from '../../server/domain/vocabulary'
import { FLEET_CONDITION } from '../../server/domain/fleet'
import { guardDisposalLine, guardDisposalOrder, onDisposalApprovalDecision, uiCompleteDisposal, uiSubmitDisposal } from '../../server/entry/disposal'
import { admin, providerStaff, stockroomWorkers } from '../shared/roles.now'
import { naasMenu } from '../shared/menu.now'

export const x_daas_ham_disposal_order = Table({
    name: 'x_daas_ham_disposal_order',
    label: 'Disposal order',
    extends: 'task',
    schema: {
        method: ChoiceColumn({ label: 'Method', choices: DISPOSAL_METHOD_CHOICES, mandatory: true, dropdown: 'dropdown_without_none' }),
        customer: ReferenceColumn({ label: 'Customer (customer-owned assets)', referenceTable: 'customer_account' }),
        disposal_vendor: ReferenceColumn({ label: 'Broker / ITAD vendor / OEM', referenceTable: 'core_company' }),
        certificate_number: StringColumn({ label: 'Certificate number', maxLength: 100 }),
        stage: ChoiceColumn({
            label: 'Stage',
            choices: DISPOSAL_STAGE_CHOICES,
            default: DISPOSAL_STAGE.draft,
            readOnly: true,
            dropdown: 'dropdown_without_none',
        }),
        /** Who decides for the Customer admins, as it was when the order was put to approval (platform/approvals). */
        approval_customer_admins: ListColumn({ label: 'Customer admins asked', referenceTable: 'sys_user', readOnly: true }),
    },
    autoNumber: { prefix: 'NDSP', number: 1000, numberOfDigits: 7 },
})

export const x_daas_ham_disposal_line = Table({
    name: 'x_daas_ham_disposal_line',
    label: 'Disposal line',
    schema: {
        disposal_order: ReferenceColumn({
            label: 'Disposal order',
            referenceTable: 'x_daas_ham_disposal_order',
            mandatory: true,
            cascadeRule: 'delete',
        }),
        asset: ReferenceColumn({ label: 'Asset', referenceTable: 'alm_hardware', mandatory: true, referenceQual: FLEET_CONDITION }),
        method: ChoiceColumn({ label: 'Method (blank = order method)', choices: DISPOSAL_METHOD_CHOICES }),
        sale_amount: DecimalColumn({ label: 'Sale amount' }),
        credit_amount: DecimalColumn({ label: 'OEM credit' }),
        status: ChoiceColumn({
            label: 'Status',
            choices: DISPOSAL_LINE_STATUS_CHOICES,
            default: DISPOSAL_LINE_STATUS.pending,
            readOnly: true,
            dropdown: 'dropdown_without_none',
        }),
        // A string column (see Order entitlement_findings): the form draws it inside its field container.
        blockers: StringColumn({ label: 'Blocked by', maxLength: 1000, readOnly: true }),
    },
    index: [{ name: 'x_daas_ham_dl_order', unique: false, element: 'disposal_order' }],
})

UiAction({
    $id: Now.ID['ua_disposal_submit'],
    name: 'Submit for approval',
    table: 'x_daas_ham_disposal_order',
    actionName: 'x_daas_ham_submit_disposal',
    condition: `current.stage == '${DISPOSAL_STAGE.draft}'`,
    roles: stockroomWorkers,
    form: { showButton: true, style: 'primary' },
    showUpdate: true,
    script: uiSubmitDisposal,
})

UiAction({
    $id: Now.ID['ua_disposal_complete'],
    name: 'Complete disposal',
    table: 'x_daas_ham_disposal_order',
    actionName: 'x_daas_ham_complete_disposal',
    hint: 'Retire every wiped asset by its method; lines that are not ready are marked blocked with the reason.',
    condition: `current.stage == '${DISPOSAL_STAGE.approved}'`,
    roles: stockroomWorkers,
    form: { showButton: true, style: 'primary' },
    showUpdate: true,
    script: uiCompleteDisposal,
})

BusinessRule({
    $id: Now.ID['br_disposal_approval_decision'],
    name: 'NaaS - roll up disposal approvals',
    table: 'sysapproval_approver',
    when: 'after',
    action: ['update'],
    order: 200,
    condition: "current.state.changes() && current.source_table == 'x_daas_ham_disposal_order'",
    script: onDisposalApprovalDecision,
})

BusinessRule({
    $id: Now.ID['br_disposal_line_frozen'],
    name: 'NaaS - freeze submitted disposal lines',
    table: 'x_daas_ham_disposal_line',
    when: 'before',
    action: ['insert', 'update', 'delete'],
    order: 100,
    script: guardDisposalLine,
})

BusinessRule({
    $id: Now.ID['br_disposal_order_frozen'],
    name: 'NaaS - freeze submitted disposal terms',
    table: 'x_daas_ham_disposal_order',
    when: 'before',
    action: ['update'],
    order: 100,
    condition: 'current.method.changes() || current.customer.changes()',
    script: guardDisposalOrder,
})

Acl({
    $id: Now.ID['acl_disposal_order_read'],
    type: 'record',
    table: 'x_daas_ham_disposal_order',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_disposal_order_create'],
    type: 'record',
    table: 'x_daas_ham_disposal_order',
    operation: 'create',
    roles: stockroomWorkers,
})

Acl({
    $id: Now.ID['acl_disposal_order_write'],
    type: 'record',
    table: 'x_daas_ham_disposal_order',
    operation: 'write',
    roles: stockroomWorkers,
})

Acl({
    $id: Now.ID['acl_disposal_order_delete'],
    type: 'record',
    table: 'x_daas_ham_disposal_order',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_disposal_line_read'],
    type: 'record',
    table: 'x_daas_ham_disposal_line',
    operation: 'read',
    roles: providerStaff,
})

Acl({
    $id: Now.ID['acl_disposal_line_create'],
    type: 'record',
    table: 'x_daas_ham_disposal_line',
    operation: 'create',
    roles: stockroomWorkers,
})

Acl({
    $id: Now.ID['acl_disposal_line_write'],
    type: 'record',
    table: 'x_daas_ham_disposal_line',
    operation: 'write',
    roles: stockroomWorkers,
})

Acl({
    $id: Now.ID['acl_disposal_line_delete'],
    type: 'record',
    table: 'x_daas_ham_disposal_line',
    operation: 'delete',
    roles: [admin],
})

Form({
    table: 'x_daas_ham_disposal_order',
    view: default_view,
    sections: [
        {
            caption: 'Disposal',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'number', type: 'table_field' }, { field: 'method', type: 'table_field' }, { field: 'disposal_vendor', type: 'table_field' }, { field: 'customer', type: 'table_field' }, { field: 'certificate_number', type: 'table_field' }],
                    rightElements: [{ field: 'stage', type: 'table_field' }, { field: 'state', type: 'table_field' }, { field: 'approval', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Notes',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ field: 'short_description', type: 'table_field' }, { field: 'work_notes', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Related',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ type: 'formatter', formatterRef: 'Activities_Filtered' }, { type: 'list', listType: '12M', listRef: 'x_daas_ham_disposal_line.disposal_order' }],
                },
            ],
        },
    ],
})

Form({
    table: 'x_daas_ham_disposal_line',
    view: default_view,
    sections: [
        {
            caption: 'Line',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'disposal_order', type: 'table_field' }, { field: 'asset', type: 'table_field' }, { field: 'method', type: 'table_field' }],
                    rightElements: [{ field: 'sale_amount', type: 'table_field' }, { field: 'credit_amount', type: 'table_field' }, { field: 'status', type: 'table_field' }, { field: 'blockers', type: 'table_field' }],
                },
            ],
        },
    ],
})

List({ table: 'x_daas_ham_disposal_order', view: default_view, columns: ['number', 'method', 'disposal_vendor', 'customer', 'stage', 'approval'] })

List({ table: 'x_daas_ham_disposal_line', view: default_view, columns: ['disposal_order', 'asset', 'method', 'status', 'sale_amount', 'credit_amount', 'blockers'] })

Record({
    $id: Now.ID['module_disposals'],
    table: 'sys_app_module',
    data: {
        title: 'Disposal orders',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_disposal_order',
        roles: providerStaff,
        active: true,
        order: 370,
    },
})
