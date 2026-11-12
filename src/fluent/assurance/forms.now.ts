import '@servicenow/sdk/global'
import { default_view, Form, List, Record } from '@servicenow/sdk/core'
import { BROAD_STAFF } from '../../server/domain/roles'
import { OPEN_EXCEPTIONS_QUERY } from '../../server/domain/reconciliation'
import { providerStaff } from '../shared/roles.now'
import { naasMenu } from '../shared/menu.now'

Form({
    table: 'x_daas_ham_audit',
    view: default_view,
    sections: [
        {
            caption: 'Audit',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'number', type: 'table_field' }, { field: 'audit_type', type: 'table_field' }, { field: 'stockroom', type: 'table_field' }, { field: 'site', type: 'table_field' }, { field: 'customer', type: 'table_field' }, { field: 'work_order', type: 'table_field' }],
                    rightElements: [{ field: 'state', type: 'table_field' }, { field: 'expected_count', type: 'table_field' }, { field: 'matched_count', type: 'table_field' }, { field: 'missing_count', type: 'table_field' }, { field: 'unexpected_count', type: 'table_field' }],
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
                    elements: [{ type: 'formatter', formatterRef: 'Activities_Filtered' }, { type: 'list', listType: '12M', listRef: 'x_daas_ham_audit_line.audit' }],
                },
            ],
        },
    ],
})

Form({
    table: 'x_daas_ham_audit_line',
    view: default_view,
    sections: [
        {
            caption: 'Line',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'audit', type: 'table_field' }, { field: 'asset', type: 'table_field' }, { field: 'scanned_code', type: 'table_field' }],
                    rightElements: [{ field: 'result', type: 'table_field' }, { field: 'scanned_at', type: 'table_field' }],
                },
            ],
        },
    ],
})

Form({
    table: 'x_daas_ham_attestation',
    view: default_view,
    sections: [
        {
            caption: 'Attestation',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'number', type: 'table_field' }, { field: 'customer', type: 'table_field' }, { field: 'site', type: 'table_field' }, { field: 'agreement', type: 'table_field' }],
                    rightElements: [{ field: 'state', type: 'table_field' }, { field: 'assigned_to', type: 'table_field' }, { field: 'attested_by', type: 'table_field' }, { field: 'attested_at', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Related',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ type: 'list', listType: '12M', listRef: 'x_daas_ham_attestation_item.attestation' }],
                },
            ],
        },
    ],
})

Form({
    table: 'x_daas_ham_attestation_item',
    view: default_view,
    sections: [
        {
            caption: 'Item',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ field: 'attestation', type: 'table_field' }, { field: 'asset', type: 'table_field' }, { field: 'response', type: 'table_field' }],
                },
            ],
        },
    ],
})

Form({
    table: 'x_daas_ham_recon_exception',
    view: default_view,
    sections: [
        {
            caption: 'Exception',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'exception_type', type: 'table_field' }, { field: 'asset', type: 'table_field' }, { field: 'ci', type: 'table_field' }, { field: 'customer', type: 'table_field' }],
                    rightElements: [{ field: 'status', type: 'table_field' }, { field: 'detected_at', type: 'table_field' }, { field: 'detail', type: 'table_field' }],
                },
            ],
        },
    ],
})

List({ table: 'x_daas_ham_audit', view: default_view, columns: ['number', 'audit_type', 'stockroom', 'site', 'state', 'expected_count', 'matched_count', 'missing_count', 'unexpected_count'] })

List({ table: 'x_daas_ham_audit_line', view: default_view, columns: ['audit', 'asset', 'scanned_code', 'result', 'scanned_at'] })

List({ table: 'x_daas_ham_attestation', view: default_view, columns: ['number', 'customer', 'site', 'state', 'assigned_to', 'attested_at'] })

List({ table: 'x_daas_ham_attestation_item', view: default_view, columns: ['attestation', 'asset', 'response'] })

List({ table: 'x_daas_ham_recon_exception', view: default_view, columns: ['detected_at', 'exception_type', 'asset', 'ci', 'customer', 'status', 'detail'] })

Record({
    $id: Now.ID['module_audits'],
    table: 'sys_app_module',
    data: {
        title: 'Audits',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_audit',
        roles: providerStaff,
        active: true,
        order: 382,
    },
})

Record({
    $id: Now.ID['module_attestations'],
    table: 'sys_app_module',
    data: {
        title: 'Attestations',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_attestation',
        roles: BROAD_STAFF,
        active: true,
        order: 384,
    },
})

Record({
    $id: Now.ID['module_exceptions'],
    table: 'sys_app_module',
    data: {
        title: 'Reconciliation exceptions',
        application: naasMenu,
        link_type: 'FILTER',
        name: 'x_daas_ham_recon_exception',
        filter: OPEN_EXCEPTIONS_QUERY,
        roles: BROAD_STAFF,
        active: true,
        order: 386,
    },
})
