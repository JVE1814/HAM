import '@servicenow/sdk/global'
import {
    CatalogItemRecordProducer,
    default_view,
    Form,
    List,
    ListCollectorVariable,
    Record,
    ReferenceVariable,
    SelectBoxVariable,
    SingleLineTextVariable,
} from '@servicenow/sdk/core'
import { afterReturnProduced } from '../../server/entry/returns'
import { FLEET_INSTALLED, SITES_OF_CUSTOMER_QUERY } from '../../server/domain/fleet'
import { SERVICE_CATALOG } from '../orders/forms.now'
import { broadStaff, orderRaisers, providerStaff } from '../shared/roles.now'
import { naasMenu } from '../shared/menu.now'

Form({
    table: 'x_daas_ham_return_order',
    view: default_view,
    sections: [
        {
            caption: 'Return',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'number', type: 'table_field' }, { field: 'trigger', type: 'table_field' }, { field: 'customer', type: 'table_field' }, { field: 'site', type: 'table_field' }, { field: 'agreement', type: 'table_field' }, { field: 'source_order', type: 'table_field' }],
                    rightElements: [{ field: 'state', type: 'table_field' }, { field: 'method', type: 'table_field' }, { field: 'due_back', type: 'table_field' }, { field: 'escalated', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Collection',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'carrier', type: 'table_field' }, { field: 'tracking_number', type: 'table_field' }],
                    rightElements: [{ field: 'work_order', type: 'table_field' }, { field: 'change_request', type: 'table_field' }],
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
                    elements: [{ type: 'formatter', formatterRef: 'Activities_Filtered' }, { type: 'list', listType: '12M', listRef: 'x_daas_ham_return_order_line.return_order' }, { type: 'list', listType: '12M', listRef: 'x_daas_ham_fee_event.return_order' }, { type: 'list', listType: '12M', listRef: 'x_daas_ham_shipment.return_order' }],
                },
            ],
        },
    ],
})

Form({
    table: 'x_daas_ham_return_order_line',
    view: default_view,
    sections: [
        {
            caption: 'Line',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'return_order', type: 'table_field' }, { field: 'asset', type: 'table_field' }, { field: 'status', type: 'table_field' }, { field: 'received_at', type: 'table_field' }],
                    rightElements: [{ field: 'condition', type: 'table_field' }, { field: 'evaluation', type: 'table_field' }],
                },
            ],
        },
    ],
})

Form({
    table: 'x_daas_ham_fee_event',
    view: default_view,
    sections: [
        {
            caption: 'Fee',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'fee_type', type: 'table_field' }, { field: 'customer', type: 'table_field' }, { field: 'agreement', type: 'table_field' }, { field: 'asset', type: 'table_field' }, { field: 'return_order', type: 'table_field' }],
                    // No currency: the fee bills in its Agreement's (its own Currency is unused). Not 'agreement.currency' either:
                    // a dot-walked field on a form is editable and saving the fee would change the whole Agreement's currency.
                    rightElements: [{ field: 'amount', type: 'table_field' }, { field: 'occurred_on', type: 'table_field' }, { field: 'status', type: 'table_field' }, { field: 'billing_period', type: 'table_field' }],
                },
            ],
        },
    ],
})

List({ table: 'x_daas_ham_return_order', view: default_view, columns: ['number', 'trigger', 'customer', 'site', 'method', 'due_back', 'state', 'escalated'] })

List({ table: 'x_daas_ham_return_order_line', view: default_view, columns: ['return_order', 'asset', 'status', 'received_at', 'condition', 'evaluation'] })

List({ table: 'x_daas_ham_fee_event', view: default_view, columns: ['occurred_on', 'fee_type', 'customer', 'asset', 'amount', 'agreement.currency', 'status'] })

/*
 * "Return or decommission equipment": customer admins and the service desk raise returns (D60). The Site choices follow
 * the chosen Customer and the device choices the chosen Site; submitting checks the same again, and that the requester
 * may raise it (domain/returns returnRequestFindings).
 */

export const requestReturn = CatalogItemRecordProducer({
    $id: Now.ID['rp_request_return'],
    name: 'Return or decommission network equipment',
    shortDescription: 'Decommission a whole site or remove individual devices; equipment is collected or shipped back.',
    table: 'x_daas_ham_return_order',
    catalogs: [SERVICE_CATALOG],
    redirectUrl: 'generatedRecord',
    variables: {
        customer: ReferenceVariable({
            question: 'Customer',
            referenceTable: 'customer_account',
            mandatory: true,
            mapToField: true,
            field: 'customer',
            order: 100,
        }),
        site: ReferenceVariable({
            question: 'Site',
            referenceTable: 'cmn_location',
            useReferenceQualifier: 'advanced',
            referenceQual: `javascript:'${SITES_OF_CUSTOMER_QUERY}' + current.variables.customer`,
            attributes: 'ref_qual_elements=customer',
            mandatory: true,
            mapToField: true,
            field: 'site',
            order: 200,
        }),
        trigger: SelectBoxVariable({
            question: 'What is being returned?',
            mandatory: true,
            mapToField: true,
            field: 'trigger',
            choices: {
                site_decommission: { label: 'The whole site (decommission)', sequence: 0 },
                device_removal: { label: 'Selected devices', sequence: 1 },
            },
            order: 300,
        }),
        assets: ListCollectorVariable({
            question: 'Devices to return (selected devices only)',
            listTable: 'alm_hardware',
            // The fleet assets installed at the chosen Site (none before a Site is chosen): the Provider IT's equipment
            // shares the table (ADR 0016). Submitting checks the fleet and the Site again.
            referenceQual: `javascript:'${FLEET_INSTALLED}^x_daas_ham_siteISNOTEMPTY^x_daas_ham_site=' + current.variables.site`,
            attributes: 'ref_qual_elements=site',
            order: 400,
        }),
        method: SelectBoxVariable({
            question: 'Collection',
            mandatory: true,
            mapToField: true,
            field: 'method',
            choices: {
                fsm_deinstall: { label: 'A field engineer de-installs and collects', sequence: 0 },
                ship_back: { label: 'Our site contact ships it back', sequence: 1 },
            },
            order: 500,
        }),
        notes: SingleLineTextVariable({
            question: 'Notes',
            mapToField: true,
            field: 'short_description',
            order: 600,
        }),
    },
    postInsertScript: afterReturnProduced,
})

Record({
    $id: Now.ID['module_request_return'],
    table: 'sys_app_module',
    data: {
        title: 'Return or decommission equipment',
        application: naasMenu,
        link_type: 'DIRECT',
        query: `com.glideapp.servicecatalog_cat_item_view.do?v=1&sysparm_id=${requestReturn.$id}`,
        roles: orderRaisers,
        active: true,
        order: 150,
    },
})

Record({
    $id: Now.ID['module_returns_open'],
    table: 'sys_app_module',
    data: {
        title: 'Open returns',
        application: naasMenu,
        link_type: 'FILTER',
        name: 'x_daas_ham_return_order',
        filter: 'active=true',
        roles: providerStaff,
        active: true,
        order: 355,
    },
})

Record({
    $id: Now.ID['module_return_lines'],
    table: 'sys_app_module',
    data: {
        title: 'Return lines',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_return_order_line',
        roles: providerStaff,
        active: true,
        order: 357,
    },
})

Record({
    $id: Now.ID['module_fee_events'],
    table: 'sys_app_module',
    data: {
        title: 'Fee events',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_fee_event',
        roles: broadStaff,
        active: true,
        order: 375,
    },
})
