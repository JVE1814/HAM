import '@servicenow/sdk/global'
import { Property, Record, ScriptAction, UiAction } from '@servicenow/sdk/core'
import { computeMargin, uiRecomputeMargin } from '../../server/entry/margin'
import { admin, finance } from '../security/roles.now'
import { BILLING_PERIOD_STATUS } from '../../server/domain/vocabulary'
import { EVENT } from '../../server/platform/events'
import { PROPERTY } from '../../server/platform/properties'

/* Cost facts and Margin per Customer and Site (P3.28). */

Record({
    $id: Now.ID['event_margin_compute'],
    table: 'sysevent_register',
    data: {
        suffix: 'margin.compute',
        event_name: EVENT.marginCompute,
        table: 'x_daas_ham_billing_period',
        description: 'Compute the cost facts and margin of a closed billing period; parm1 = period, parm2 = cursor.',
        priority: 200,
    },
})

ScriptAction({
    $id: Now.ID['sa_margin_compute'],
    name: 'NaaS - compute margin',
    eventName: EVENT.marginCompute,
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
    condition: `current.status == '${BILLING_PERIOD_STATUS.closed}'`,
    roles: [finance],
    form: { showButton: true },
    showUpdate: true,
    script: uiRecomputeMargin,
})

Property({
    $id: Now.ID['prop_margin_amortisation_months'],
    name: PROPERTY.amortisationMonths.name,
    type: 'integer',
    value: PROPERTY.amortisationMonths.default,
    description: 'Months over which the purchase cost of Provider-owned equipment is written off in margin.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_margin_visit_cost'],
    name: PROPERTY.visitCost.name,
    type: 'integer',
    value: PROPERTY.visitCost.default,
    description: 'Labour cost of a field work order that has no NaaS field labour cost of its own.',
    roles: { read: [admin], write: [admin] },
})
