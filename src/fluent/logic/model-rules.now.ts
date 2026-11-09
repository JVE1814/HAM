import '@servicenow/sdk/global'
import { BusinessRule } from '@servicenow/sdk/core'
import { processAsnRow, processLifecycleRow } from '../../server/entry/imports'
import { onAgreementTermsChanged, onModelLifecycleChanged, onNormalizationResolved } from '../../server/entry/models'
import { processCoverageRow } from '../../server/entry/oem-sync'

/* Rules for model data, agreements' refresh terms and import-set rows. */

/*
 * cmdb_model_lifecycle is the platform's table (ADR 0017), which holds the milestones of the Provider IT's Models too
 * (ADR 0016), and a rule on it runs for its child classes as well. The platform runs a condition on every save of the
 * table, so it starts with its change test (what a Model's milestones are read from), then keeps to NaaS Models: those
 * with an OEM PID. The condition field holds at most 254 characters.
 */
BusinessRule({
    $id: Now.ID['br_model_lifecycle_changed'],
    name: 'NaaS - model lifecycle changed',
    table: 'cmdb_model_lifecycle',
    when: 'after',
    action: ['insert', 'update'],
    order: 200,
    condition:
        "(current.operation() == 'insert' || current.start_date.changes() || current.active.changes() || current.lifecycle_phase.changes() || current.lifecycle_type.changes() || current.model.changes()) && current.model.x_daas_ham_oem_pid != ''",
    script: onModelLifecycleChanged,
})

BusinessRule({
    $id: Now.ID['br_agreement_terms_changed'],
    name: 'NaaS - agreement refresh terms changed',
    table: 'x_daas_ham_agreement',
    when: 'after',
    action: ['update'],
    order: 200,
    condition: 'current.refresh_cycle_months.changes() || current.refresh_basis.changes()',
    script: onAgreementTermsChanged,
})

BusinessRule({
    $id: Now.ID['br_norm_exception_resolved'],
    name: 'NaaS - learn from resolved exceptions',
    table: 'x_daas_ham_norm_exception',
    when: 'after',
    action: ['update'],
    order: 200,
    condition: "current.resolved_model.changes() && current.resolved_model != '' && current.status == 'open'",
    script: onNormalizationResolved,
})

BusinessRule({
    $id: Now.ID['br_asn_row'],
    name: 'NaaS - process ASN row',
    table: 'x_daas_ham_asn_import',
    when: 'after',
    action: ['insert'],
    order: 200,
    script: processAsnRow,
})

BusinessRule({
    $id: Now.ID['br_eox_row'],
    name: 'NaaS - process lifecycle import row',
    table: 'x_daas_ham_eox_import',
    when: 'after',
    action: ['insert'],
    order: 200,
    script: processLifecycleRow,
})

BusinessRule({
    $id: Now.ID['br_coverage_row'],
    name: 'NaaS - process OEM coverage import row',
    table: 'x_daas_ham_coverage_import',
    when: 'after',
    action: ['insert'],
    order: 200,
    script: processCoverageRow,
})
