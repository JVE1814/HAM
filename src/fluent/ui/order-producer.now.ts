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

/* "Request network equipment": the one catalog entry point for Orders (D42/D50). */

const SERVICE_CATALOG = 'e0d08b13c3330100c8b837659bba8fb4'

export const deviceRows = VariableSet({
    $id: Now.ID['vs_order_devices'],
    title: 'Individual devices',
    internalName: 'devices',
    type: 'multiRow',
    variables: {
        model: ReferenceVariable({
            question: 'Model',
            referenceTable: 'cmdb_model',
            referenceQualCondition: 'x_daas_ham_device_classISNOTEMPTY^x_daas_ham_device_class!=optic',
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
            mandatory: true,
            mapToField: true,
            field: 'agreement',
            order: 200,
        }),
        site: ReferenceVariable({
            question: 'Site',
            referenceTable: 'cmn_location',
            referenceQualCondition: 'x_daas_ham_is_site=true',
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
                site_rollout: { label: 'Site rollout', sequence: 0 },
                device_add: { label: 'Device add', sequence: 1 },
                device_replace: { label: 'Device replace', sequence: 2 },
                temporary: { label: 'Temporary deployment', sequence: 3 },
            },
            order: 400,
        }),
        site_template: ReferenceVariable({
            question: 'Site template',
            referenceTable: 'x_daas_ham_site_template',
            referenceQualCondition: 'active=true',
            mapToField: true,
            field: 'site_template',
            order: 500,
        }),
        install_mode: SelectBoxVariable({
            question: 'Install mode',
            mandatory: true,
            mapToField: true,
            field: 'install_mode',
            choices: {
                fsm_engineer: { label: 'Provider field engineer', sequence: 0 },
                self_install: { label: 'Customer self-install (ZTP)', sequence: 1 },
                subcontractor: { label: 'Subcontractor', sequence: 2 },
                remote_hands: { label: 'Data-centre remote hands', sequence: 3 },
            },
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
