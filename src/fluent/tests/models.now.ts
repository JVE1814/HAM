import '@servicenow/sdk/global'
import { Test } from '@servicenow/sdk/core'

/*
 * ATF: a Model's manufacturer milestones are kept in the platform's Model lifecycle table (ADR 0017; suite "NaaS - P1").
 * The recomputation of the Model's fleet assets is not tested here: it runs from the event queue, after the test.
 */

export const lifecycleImportTest = Test(
    {
        $id: Now.ID['atf_lifecycle_import'],
        name: 'NaaS - a lifecycle import row stores its milestones on the model',
        description:
            "A lifecycle import row for a NaaS Model stores each milestone it gives as an active Publisher row of the platform's Model lifecycle table, and no row for a milestone it leaves blank.",
        active: true,
        // A row inserted outside an import set is transformed at once by the platform, which logs that the table has no
        // transform map (the app processes its rows by rule): the steps below check the outcome instead.
        failOnServerError: false,
    },
    (atf) => {
        const model = atf.server.recordInsert({
            $id: Now.ID['atf_lci_model'],
            table: 'cmdb_hardware_product_model',
            fieldValues: { name: 'ATF Lifecycle Switch', x_daas_ham_oem_pid: 'ATF-EOX-24', x_daas_ham_device_class: 'switch' },
        })
        const row = atf.server.recordInsert({
            $id: Now.ID['atf_lci_row'],
            table: 'x_daas_ham_eox_import',
            fieldValues: { pid: 'ATF-EOX-24', end_of_sale: '2020-01-31', end_of_support: '2040-01-31', source_reference: 'ATF-BULLETIN-1' },
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_lci_row_imported'],
            table: 'x_daas_ham_eox_import',
            recordId: row.record_id,
            fieldValues: 'sys_import_state=inserted',
            assert: 'record_validated',
        })
        atf.server.recordQuery({
            $id: Now.ID['atf_lci_end_of_sale'],
            table: 'cmdb_hardware_model_lifecycle',
            fieldValues: `model=${model.record_id}^lifecycle_phase=end_of_sale^start_date=2020-01-31^lifecycle_type=publisher^source=internal^active=true^description=CSV import: ATF-BULLETIN-1`,
            assert: 'records_match_query',
        })
        atf.server.recordQuery({
            $id: Now.ID['atf_lci_end_of_support'],
            table: 'cmdb_hardware_model_lifecycle',
            fieldValues: `model=${model.record_id}^lifecycle_phase=end_of_support^start_date=2040-01-31^lifecycle_type=publisher^source=internal^active=true`,
            assert: 'records_match_query',
        })
        atf.server.recordQuery({
            $id: Now.ID['atf_lci_no_other_milestone'],
            table: 'cmdb_model_lifecycle',
            fieldValues: `model=${model.record_id}^lifecycle_phaseNOT INend_of_sale,end_of_support`,
            assert: 'no_records_match_query',
        })
    },
)
