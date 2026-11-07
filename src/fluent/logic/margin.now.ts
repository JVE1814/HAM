import '@servicenow/sdk/global'
import { Property, Record, ScriptAction, UiAction } from '@servicenow/sdk/core'
import { computeMargin, uiRecomputeMargin } from '../../server/entry/margin'
import { admin, finance } from '../security/roles.now'

/* Cost facts and Margin per Customer and Site (P3.28). */

export const marginComputeEvent = Record({
    $id: Now.ID['event_margin_compute'],
    table: 'sysevent_register',
    data: {
        suffix: 'margin.compute',
        event_name: 'x_daas_ham.margin.compute',
        table: 'x_daas_ham_billing_period',
        description: 'Compute the cost facts and margin of a closed billing period; parm1 = period, parm2 = cursor.',
        fired_by: 'entry/billing.ts uiCloseBillingPeriod, entry/margin.ts uiRecomputeMargin',
        priority: 200,
    },
})

ScriptAction({
    $id: Now.ID['sa_margin_compute'],
    name: 'NaaS - compute margin',
    eventName: 'x_daas_ham.margin.compute',
    active: true,
    script: computeMargin,
    description: "Attributes asset, lease, OEM support and field labour costs to customers and sites, then subtracts them from the period's revenue.",
})

UiAction({
    $id: Now.ID['ua_billing_recompute_margin'],
    name: 'Recompute margin',
    table: 'x_daas_ham_billing_period',
    actionName: 'x_daas_ham_billing_recompute_margin',
    hint: 'Rebuild the cost facts and margin of this closed period from current costs.',
    condition: "current.status == 'closed'",
    roles: [finance],
    form: { showButton: true },
    showUpdate: false,
    script: uiRecomputeMargin,
})

Property({
    $id: Now.ID['prop_margin_amortisation_months'],
    name: 'x_daas_ham.margin.amortisation_months',
    type: 'integer',
    value: 60,
    description: 'Months over which the purchase cost of Provider-owned equipment is written off in margin.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_margin_visit_cost'],
    name: 'x_daas_ham.margin.visit_cost',
    type: 'integer',
    value: 250,
    description: 'Labour cost of a field work order that has no NaaS field labour cost of its own.',
    roles: { read: [admin], write: [admin] },
})
