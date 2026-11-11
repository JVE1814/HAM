import '@servicenow/sdk/global'
import {
    CatalogItemRecordProducer,
    DateVariable,
    default_view,
    Form,
    List,
    MultiLineTextVariable,
    Record,
    ReferenceVariable,
    SelectBoxVariable,
    SingleLineTextVariable,
    VariableSet,
} from '@servicenow/sdk/core'
import { DEVICE_CLASS, INSTALL_MODE_CHOICES, ORDER_TYPE_CHOICES } from '../../server/domain/vocabulary'
import { NAAS_MODEL_CONDITION, SITES_OF_CUSTOMER_QUERY } from '../../server/domain/fleet'
import { afterOrderProduced } from '../../server/entry/orders'
import { OPEN_ORDERS_QUERY } from '../../server/domain/fulfilment'
import { orderRaisers, providerStaff } from '../shared/roles.now'
import { naasMenu } from '../shared/menu.now'

Form({
    table: 'x_daas_ham_order',
    view: default_view,
    sections: [
        {
            caption: 'Order',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'number', type: 'table_field' }, { field: 'customer', type: 'table_field' }, { field: 'agreement', type: 'table_field' }, { field: 'site', type: 'table_field' }, { field: 'order_type', type: 'table_field' }, { field: 'site_template', type: 'table_field' }],
                    rightElements: [{ field: 'stage', type: 'table_field' }, { field: 'state', type: 'table_field' }, { field: 'approval', type: 'table_field' }, { field: 'install_mode', type: 'table_field' }, { field: 'requested_date', type: 'table_field' }, { field: 'end_date', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Entitlement',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ field: 'entitlement_verdict', type: 'table_field' }, { field: 'entitlement_findings', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Delivery',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'carrier', type: 'table_field' }, { field: 'tracking_number', type: 'table_field' }],
                    rightElements: [{ field: 'change_request', type: 'table_field' }, { field: 'work_order', type: 'table_field' }, { field: 'case', type: 'table_field' }, { field: 'return_raised', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Notes',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ field: 'short_description', type: 'table_field' }, { field: 'description', type: 'table_field' }, { field: 'work_notes', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Related',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ type: 'formatter', formatterRef: 'Activities_Filtered' }, { type: 'list', listType: '12M', listRef: 'x_daas_ham_order_line.order' }, { type: 'list', listType: '12M', listRef: 'x_daas_ham_shipment.order' }],
                },
            ],
        },
    ],
})

Form({
    table: 'x_daas_ham_order_line',
    view: default_view,
    sections: [
        {
            caption: 'Line',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'number', type: 'table_field' }, { field: 'order', type: 'table_field' }, { field: 'model', type: 'table_field' }, { field: 'quantity', type: 'table_field' }, { field: 'replaces_asset', type: 'table_field' }, { field: 'from_site_template', type: 'table_field' }],
                    rightElements: [{ field: 'line_stage', type: 'table_field' }, { field: 'quantity_allocated', type: 'table_field' }, { field: 'quantity_to_purchase', type: 'table_field' }, { field: 'sourcing_summary', type: 'table_field' }, { field: 'transfer_orders', type: 'table_field' }, { field: 'purchase_order', type: 'table_field' }, { field: 'purchase_orders', type: 'table_field' }],
                },
            ],
        },
        {
            caption: 'Related',
            content: [
                {
                    layout: 'one-column',
                    elements: [{ type: 'list', listType: '12M', listRef: 'alm_hardware.x_daas_ham_order_line' }, { type: 'list', listType: '12M', listRef: 'x_daas_ham_staging_task.order_line' }],
                },
            ],
        },
    ],
})

List({ table: 'x_daas_ham_order', view: default_view, columns: ['number', 'customer', 'site', 'order_type', 'stage', 'entitlement_verdict', 'install_mode', 'requested_date'] })

List({ table: 'x_daas_ham_order_line', view: default_view, columns: ['number', 'order', 'model', 'quantity', 'line_stage', 'quantity_allocated', 'quantity_to_purchase'] })

/*
 * "Request network equipment": the one catalog entry point for Orders. The Agreement, Site and Site template
 * choices follow the chosen Customer; submitting checks the same again (domain/entitlement ownershipFindings).
 */

/** The platform's Service Catalog (sc_catalog), which the app's catalog items are listed in. */
export const SERVICE_CATALOG = 'e0d08b13c3330100c8b837659bba8fb4'

export const deviceRows = VariableSet({
    $id: Now.ID['vs_order_devices'],
    title: 'Individual devices',
    internalName: 'devices',
    type: 'multiRow',
    variables: {
        model: ReferenceVariable({
            question: 'Model',
            referenceTable: 'cmdb_model',
            // NaaS Models (ADR 0016) of a device class other than optic.
            referenceQualCondition: `${NAAS_MODEL_CONDITION}^x_daas_ham_device_classISNOTEMPTY^x_daas_ham_device_class!=${DEVICE_CLASS.optic}`,
            mandatory: true,
            order: 100,
        }),
        quantity: SingleLineTextVariable({
            question: 'Quantity',
            defaultValue: '1',
            mandatory: true,
            order: 200,
        }),
    },
})

export const requestNetworkEquipment = CatalogItemRecordProducer({
    $id: Now.ID['rp_request_network_equipment'],
    name: 'Request network equipment',
    shortDescription: 'Order a site rollout or individual network devices for a customer site.',
    description:
        'Choose a site template for a new site, add individual devices, or both. Orders within the customer agreement are fulfilled automatically; others go to the customer admin (and account manager) for approval.',
    table: 'x_daas_ham_order',
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
        agreement: ReferenceVariable({
            question: 'Agreement',
            referenceTable: 'x_daas_ham_agreement',
            useReferenceQualifier: 'advanced',
            referenceQual: "javascript:'customer=' + current.variables.customer",
            attributes: 'ref_qual_elements=customer',
            mandatory: true,
            mapToField: true,
            field: 'agreement',
            order: 200,
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
            order: 300,
        }),
        order_type: SelectBoxVariable({
            question: 'Order type',
            mandatory: true,
            mapToField: true,
            field: 'order_type',
            choices: {
                site_rollout: ORDER_TYPE_CHOICES.site_rollout,
                device_add: ORDER_TYPE_CHOICES.device_add,
                device_replace: ORDER_TYPE_CHOICES.device_replace,
                temporary: ORDER_TYPE_CHOICES.temporary,
            },
            order: 400,
        }),
        site_template: ReferenceVariable({
            question: 'Site template',
            referenceTable: 'x_daas_ham_site_template',
            useReferenceQualifier: 'advanced',
            // A Site template with no Customer is offered to every Customer.
            referenceQual: "javascript:'active=true^customerISEMPTY^ORcustomer=' + current.variables.customer",
            attributes: 'ref_qual_elements=customer',
            mapToField: true,
            field: 'site_template',
            order: 500,
        }),
        install_mode: SelectBoxVariable({
            question: 'Install mode',
            mandatory: true,
            mapToField: true,
            field: 'install_mode',
            choices: INSTALL_MODE_CHOICES,
            order: 600,
        }),
        requested_date: DateVariable({
            question: 'Requested install date',
            mapToField: true,
            field: 'requested_date',
            order: 700,
        }),
        end_date: DateVariable({
            question: 'Deployment end date (temporary deployments)',
            mapToField: true,
            field: 'end_date',
            order: 800,
        }),
        notes: MultiLineTextVariable({
            question: 'Notes',
            mapToField: true,
            field: 'description',
            order: 900,
        }),
    },
    variableSets: [{ variableSet: deviceRows, order: 1000 }],
    postInsertScript: afterOrderProduced,
})

Record({
    $id: Now.ID['module_request'],
    table: 'sys_app_module',
    data: {
        title: 'Request network equipment',
        application: naasMenu,
        link_type: 'DIRECT',
        query: `com.glideapp.servicecatalog_cat_item_view.do?v=1&sysparm_id=${requestNetworkEquipment.$id}`,
        roles: orderRaisers,
        active: true,
        order: 120,
    },
})

Record({
    $id: Now.ID['module_orders_open'],
    table: 'sys_app_module',
    data: {
        title: 'Open orders',
        application: naasMenu,
        link_type: 'FILTER',
        name: 'x_daas_ham_order',
        filter: OPEN_ORDERS_QUERY,
        roles: providerStaff,
        active: true,
        order: 210,
    },
})

Record({
    $id: Now.ID['module_orders_all'],
    table: 'sys_app_module',
    data: {
        title: 'All orders',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_order',
        roles: providerStaff,
        active: true,
        order: 220,
    },
})

Record({
    $id: Now.ID['module_order_lines'],
    table: 'sys_app_module',
    data: {
        title: 'Order lines',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_order_line',
        roles: providerStaff,
        active: true,
        order: 230,
    },
})
