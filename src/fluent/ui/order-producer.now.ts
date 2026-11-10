import '@servicenow/sdk/global'
import {
    CatalogItemRecordProducer,
    DateVariable,
    MultiLineTextVariable,
    ReferenceVariable,
    SelectBoxVariable,
    SingleLineTextVariable,
    VariableSet,
} from '@servicenow/sdk/core'
import { afterOrderProduced } from '../../server/entry/orders'
import { DEVICE_CLASS, INSTALL_MODE_CHOICES, ORDER_TYPE_CHOICES } from '../../server/domain/vocabulary'
import { NAAS_MODEL_CONDITION, SITES_OF_CUSTOMER_QUERY } from '../../server/domain/fleet'

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
