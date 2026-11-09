import '@servicenow/sdk/global'
import { Record, ScriptAction } from '@servicenow/sdk/core'
import { refreshAgreementAssets, refreshModelAssets } from '../../server/entry/models'
import { sourceOrder } from '../../server/entry/orders'
import { EVENT } from '../../server/platform/events'

/* The Order, Model and Agreement events (platform/events EVENT) and the script actions that answer them. */

Record({
    $id: Now.ID['event_order_source'],
    table: 'sysevent_register',
    data: {
        suffix: 'order.source',
        event_name: EVENT.sourceOrder,
        table: 'x_daas_ham_order',
        description: 'An approved Order needs its lines sourced.',
        priority: 100,
    },
})

ScriptAction({
    $id: Now.ID['sa_order_source'],
    name: 'NaaS - source order',
    eventName: EVENT.sourceOrder,
    active: true,
    script: sourceOrder,
    description: 'Allocates stock, requests transfers and purchases, and opens staging tasks for an approved Order.',
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
