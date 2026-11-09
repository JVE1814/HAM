import '@servicenow/sdk/global'
import { ChoiceColumn, DateTimeColumn, IntegerColumn, ReferenceColumn, StringColumn, Table } from '@servicenow/sdk/core'
import {
    ATTESTATION_RESPONSE_CHOICES,
    AUDIT_LINE_RESULT_CHOICES,
    AUDIT_TYPE_CHOICES,
    EXCEPTION_STATUS_CHOICES,
    EXCEPTION_TYPE_CHOICES,
} from '../../server/domain/vocabulary'

/* Audits, attestations and reconciliation exceptions (P2.7, D63). */

/** A check of what is physically present: a stockroom blind count or a site audit. */
export const x_daas_ham_audit = Table({
    name: 'x_daas_ham_audit',
    label: 'Audit',
    extends: 'task',
    schema: {
        audit_type: ChoiceColumn({
            label: 'Audit type',
            choices: AUDIT_TYPE_CHOICES,
            mandatory: true,
            dropdown: 'dropdown_without_none',
        }),
        // The pickers here offer NaaS stockrooms and fleet assets only (ADR 0016): domain/fleet's conditions.
        stockroom: ReferenceColumn({
            label: 'Stockroom',
            referenceTable: 'alm_stockroom',
            referenceQual: 'x_daas_ham_stockroom_typeINcentral_depot,staging_centre,customer_site',
        }),
        site: ReferenceColumn({ label: 'Site', referenceTable: 'cmn_location' }),
        customer: ReferenceColumn({ label: 'Customer', referenceTable: 'customer_account' }),
        expected_count: IntegerColumn({ label: 'Expected', readOnly: true, default: 0 }),
        matched_count: IntegerColumn({ label: 'Found', readOnly: true, default: 0 }),
        missing_count: IntegerColumn({ label: 'Missing', readOnly: true, default: 0 }),
        unexpected_count: IntegerColumn({ label: 'Unexpected', readOnly: true, default: 0 }),
        work_order: ReferenceColumn({ label: 'Work order', referenceTable: 'wm_order' }),
    },
    autoNumber: { prefix: 'NAUD', number: 1000, numberOfDigits: 7 },
})

export const x_daas_ham_audit_line = Table({
    name: 'x_daas_ham_audit_line',
    label: 'Audit line',
    schema: {
        audit: ReferenceColumn({ label: 'Audit', referenceTable: 'x_daas_ham_audit', mandatory: true, cascadeRule: 'delete' }),
        asset: ReferenceColumn({ label: 'Asset', referenceTable: 'alm_hardware', referenceQual: 'x_daas_ham_fleet=true' }),
        scanned_code: StringColumn({ label: 'Scanned code', maxLength: 100 }),
        result: ChoiceColumn({
            label: 'Result',
            choices: AUDIT_LINE_RESULT_CHOICES,
            default: 'expected',
            readOnly: true,
            dropdown: 'dropdown_without_none',
        }),
        scanned_at: DateTimeColumn({ label: 'Scanned at', readOnly: true }),
    },
    index: [{ name: 'x_daas_ham_al_audit', unique: false, element: 'audit' }],
})

/** A Customer admin's periodic confirmation of the Assets installed at a Site. */
export const x_daas_ham_attestation = Table({
    name: 'x_daas_ham_attestation',
    label: 'Attestation',
    extends: 'task',
    schema: {
        customer: ReferenceColumn({ label: 'Customer', referenceTable: 'customer_account', mandatory: true }),
        site: ReferenceColumn({ label: 'Site', referenceTable: 'cmn_location', mandatory: true }),
        agreement: ReferenceColumn({ label: 'Agreement', referenceTable: 'x_daas_ham_agreement' }),
        attested_by: ReferenceColumn({ label: 'Attested by', referenceTable: 'sys_user', readOnly: true }),
        attested_at: DateTimeColumn({ label: 'Attested at', readOnly: true }),
    },
    autoNumber: { prefix: 'NATT', number: 1000, numberOfDigits: 7 },
    index: [
        { name: 'x_daas_ham_att_customer', unique: false, element: 'customer' },
        { name: 'x_daas_ham_att_site', unique: false, element: 'site' },
    ],
})

export const x_daas_ham_attestation_item = Table({
    name: 'x_daas_ham_attestation_item',
    label: 'Attestation item',
    schema: {
        attestation: ReferenceColumn({ label: 'Attestation', referenceTable: 'x_daas_ham_attestation', mandatory: true, cascadeRule: 'delete' }),
        asset: ReferenceColumn({ label: 'Asset', referenceTable: 'alm_hardware', mandatory: true, referenceQual: 'x_daas_ham_fleet=true' }),
        response: ChoiceColumn({
            label: 'Response',
            choices: ATTESTATION_RESPONSE_CHOICES,
        }),
    },
    index: [{ name: 'x_daas_ham_ati_att', unique: false, element: 'attestation' }],
})

/** A disagreement between Assets and monitoring, an audit or an attestation, or a rack's placements. */
export const x_daas_ham_recon_exception = Table({
    name: 'x_daas_ham_recon_exception',
    label: 'Reconciliation exception',
    schema: {
        exception_type: ChoiceColumn({
            label: 'Type',
            choices: EXCEPTION_TYPE_CHOICES,
            mandatory: true,
            dropdown: 'dropdown_without_none',
        }),
        asset: ReferenceColumn({ label: 'Asset', referenceTable: 'alm_hardware', referenceQual: 'x_daas_ham_fleet=true' }),
        ci: ReferenceColumn({ label: 'Configuration item', referenceTable: 'cmdb_ci' }),
        customer: ReferenceColumn({ label: 'Customer', referenceTable: 'core_company' }),
        detail: StringColumn({ label: 'Detail', maxLength: 255 }),
        status: ChoiceColumn({
            label: 'Status',
            choices: EXCEPTION_STATUS_CHOICES,
            default: 'open',
            dropdown: 'dropdown_without_none',
        }),
        detected_at: DateTimeColumn({ label: 'Detected at', readOnly: true }),
    },
    index: [
        { name: 'x_daas_ham_rx_asset', unique: false, element: 'asset' },
        { name: 'x_daas_ham_rx_status', unique: false, element: 'status' },
    ],
})
