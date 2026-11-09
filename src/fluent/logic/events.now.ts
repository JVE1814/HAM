import '@servicenow/sdk/global'
import { Record, ScriptAction } from '@servicenow/sdk/core'
import { refreshAgreementAssets, refreshModelAssets } from '../../server/entry/models'
import { sourceOrder } from '../../server/entry/orders'

/* Events fired by platform/events.ts and the script actions that consume them. */

export const orderSourceEvent = Record({
    $id: Now.ID['event_order_source'],
    table: 'sysevent_register',
    data: {
        suffix: 'order.source',
        event_name: 'x_daas_ham.order.source',
        table: 'x_daas_ham_order',
        description: 'An approved Order needs its lines sourced.',
        fired_by: 'entry/orders.ts startSourcing',
        priority: 100,
    },
})

ScriptAction({
    $id: Now.ID['sa_order_source'],
    name: 'NaaS - source order',
    eventName: 'x_daas_ham.order.source',
    active: true,
    script: sourceOrder,
    description: 'Allocates stock, requests transfers and purchases, and opens staging tasks for an approved Order.',
})

export const lifecycleChangedEvent = Record({
    $id: Now.ID['event_model_lifecycle'],
    table: 'sysevent_register',
    data: {
        suffix: 'model.lifecycle',
        event_name: 'x_daas_ham.model.lifecycle',
        table: 'x_daas_ham_model_lifecycle',
        description: "A model's lifecycle milestones changed or one was crossed; parm1 = model, parm2 = cursor.",
        fired_by: 'entry/models.ts onModelLifecycleChanged, rollLifecyclePhases',
        priority: 200,
    },
})

ScriptAction({
    $id: Now.ID['sa_model_lifecycle'],
    name: 'NaaS - refresh model assets lifecycle',
    eventName: 'x_daas_ham.model.lifecycle',
    active: true,
    script: refreshModelAssets,
    description: "Recomputes lifecycle phase and refresh due date for a model's assets in time-boxed chunks.",
})

export const agreementTermsEvent = Record({
    $id: Now.ID['event_agreement_terms'],
    table: 'sysevent_register',
    data: {
        suffix: 'agreement.terms',
        event_name: 'x_daas_ham.agreement.terms',
        table: 'x_daas_ham_agreement',
        description: "An agreement's refresh terms changed; parm1 = agreement, parm2 = cursor.",
        fired_by: 'entry/models.ts onAgreementTermsChanged',
        priority: 200,
    },
})

ScriptAction({
    $id: Now.ID['sa_agreement_terms'],
    name: 'NaaS - refresh due of agreement assets',
    eventName: 'x_daas_ham.agreement.terms',
    active: true,
    script: refreshAgreementAssets,
    description: "Recomputes refresh due dates for an agreement's deployed assets in time-boxed chunks.",
})
