import '@servicenow/sdk/global'
import { CatalogItemRecordProducer, ListCollectorVariable, ReferenceVariable, SelectBoxVariable, SingleLineTextVariable } from '@servicenow/sdk/core'
import { afterReturnProduced } from '../../server/entry/returns'

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
    catalogs: ['e0d08b13c3330100c8b837659bba8fb4'],
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
            referenceQual: "javascript:'x_daas_ham_is_site=true^company=' + current.variables.customer",
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
            // The fleet assets installed at the chosen Site (none before a Site is chosen), domain/fleet fleetCondition: the
            // Provider IT's equipment shares the table (ADR 0016). Submitting checks the fleet and the Site again.
            referenceQual: "javascript:'x_daas_ham_fleet=true^install_status=1^x_daas_ham_siteISNOTEMPTY^x_daas_ham_site=' + current.variables.site",
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
