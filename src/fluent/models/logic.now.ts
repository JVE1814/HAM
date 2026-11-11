import '@servicenow/sdk/global'
import { BusinessRule, Record, ScheduledScript, ScriptAction } from '@servicenow/sdk/core'
import {
    normalizeRawModels,
    onAgreementTermsChanged,
    onModelLifecycleChanged,
    onNormalizationResolved,
    processLifecycleRow,
    refreshAgreementAssets,
    refreshModelAssets,
    rollLifecyclePhases,
} from '../../server/entry/models'
import { MILESTONE_ROW_CHANGED, MODEL_LIFECYCLE } from '../../server/domain/model-lifecycle'
import { NORM_EXCEPTION_STATUS } from '../../server/domain/vocabulary'
import { EVENT } from '../../server/domain/events'

/* Rules, events and jobs for model data, agreements' refresh terms and lifecycle import rows. */

/*
 * cmdb_model_lifecycle is the platform's table (ADR 0017), which holds the milestones of the Provider IT's Models too
 * (ADR 0016), and a rule on it runs for its child classes as well. The platform runs a condition on every save of the
 * table, so the condition is the change test alone (what a Model's milestones are read from; a new or deleted row
 * always counts). A row can leave one Model for another, and `previous` is null on an insert and a delete, so the
 * script keeps to NaaS Models, not the condition. The condition field holds at most 254 characters.
 */
BusinessRule({
    $id: Now.ID['br_model_lifecycle_changed'],
    name: 'NaaS - model lifecycle changed',
    table: MODEL_LIFECYCLE.table,
    when: 'after',
    action: ['insert', 'update', 'delete'],
    order: 200,
    condition: MILESTONE_ROW_CHANGED,
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
    condition: `current.resolved_model.changes() && current.resolved_model != '' && current.status == '${NORM_EXCEPTION_STATUS.open}'`,
    script: onNormalizationResolved,
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

Record({
    $id: Now.ID['event_model_lifecycle'],
    table: 'sysevent_register',
    data: {
        suffix: 'model.lifecycle',
        event_name: EVENT.lifecycleChanged,
        table: 'cmdb_model',
        description: "A model's lifecycle milestones changed or one was crossed; parm1 = model, parm2 = cursor.",
        priority: 200,
    },
})

ScriptAction({
    $id: Now.ID['sa_model_lifecycle'],
    name: 'NaaS - refresh model assets lifecycle',
    eventName: EVENT.lifecycleChanged,
    active: true,
    script: refreshModelAssets,
    description: "Recomputes lifecycle phase and refresh due date for a model's assets in time-boxed chunks.",
})

Record({
    $id: Now.ID['event_agreement_terms'],
    table: 'sysevent_register',
    data: {
        suffix: 'agreement.terms',
        event_name: EVENT.agreementTermsChanged,
        table: 'x_daas_ham_agreement',
        description: "An agreement's refresh terms changed; parm1 = agreement, parm2 = cursor.",
        priority: 200,
    },
})

ScriptAction({
    $id: Now.ID['sa_agreement_terms'],
    name: 'NaaS - refresh due of agreement assets',
    eventName: EVENT.agreementTermsChanged,
    active: true,
    script: refreshAgreementAssets,
    description: "Recomputes refresh due dates for an agreement's deployed assets in time-boxed chunks.",
})

ScheduledScript({
    $id: Now.ID['job_normalize_raw_models'],
    name: 'NaaS - normalize discovered models',
    active: true,
    frequency: 'periodically',
    executionInterval: { hours: 1 },
    executionStart: '2026-01-01 00:20:00',
    timeZone: 'UTC',
    script: normalizeRawModels,
})

ScheduledScript({
    $id: Now.ID['job_roll_lifecycle_phases'],
    name: 'NaaS - roll lifecycle phases',
    active: true,
    frequency: 'daily',
    executionTime: { hours: 0, minutes: 15, seconds: 0 },
    timeZone: 'UTC',
    script: rollLifecyclePhases,
})
