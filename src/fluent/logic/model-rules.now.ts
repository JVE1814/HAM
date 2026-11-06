import '@servicenow/sdk/global'
import { BusinessRule } from '@servicenow/sdk/core'
import { processAsnRow, processLifecycleRow } from '../../server/entry/imports'
import { onAgreementTermsChanged, onModelLifecycleChanged, onNormalizationResolved } from '../../server/entry/models'

/* Rules for model data, agreements' refresh terms and import-set rows. */

BusinessRule({
    $id: Now.ID['br_model_lifecycle_changed'],
    name: 'NaaS - model lifecycle changed',
    table: 'x_daas_ham_model_lifecycle',
    when: 'after',
    action: ['insert', 'update'],
    order: 200,
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
    name: 'NaaS - learn from resolved normalization exception',
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
