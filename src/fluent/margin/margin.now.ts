import '@servicenow/sdk/global'
import {
    Acl,
    ChoiceColumn,
    DecimalColumn,
    default_view,
    Form,
    List,
    Property,
    Record,
    ReferenceColumn,
    ScriptAction,
    StringColumn,
    Table,
    UiAction,
} from '@servicenow/sdk/core'
import { BILLING_PERIOD_STATUS, COST_TYPE_CHOICES } from '../../server/domain/vocabulary'
import { EVENT } from '../../server/platform/events'
import { computeMargin, uiRecomputeMargin } from '../../server/entry/margin'
import { PROPERTY } from '../../server/platform/properties'
import { admin, finance, moneyReaders } from '../shared/roles.now'

/* Cost facts and Margin per Customer, Site and currency (plan §13 Margin / TCO, Q72). */

/** A cost attributed to a Customer and Site, in one currency, for one Billing period. */
export const x_daas_ham_cost_fact = Table({
    name: 'x_daas_ham_cost_fact',
    label: 'Cost fact',
    schema: {
        billing_period: ReferenceColumn({ label: 'Billing period', referenceTable: 'x_daas_ham_billing_period', mandatory: true, cascadeRule: 'delete' }),
        customer: ReferenceColumn({ label: 'Customer', referenceTable: 'customer_account', mandatory: true }),
        site: ReferenceColumn({ label: 'Site', referenceTable: 'cmn_location' }),
        cost_type: ChoiceColumn({
            label: 'Cost type',
            choices: COST_TYPE_CHOICES,
            mandatory: true,
            dropdown: 'dropdown_without_none',
        }),
        amount: DecimalColumn({ label: 'Amount', mandatory: true }),
        // Its Agreement's (a shipment's, its carrier's), set by the margin pass: never a default.
        currency: StringColumn({ label: 'Currency', maxLength: 3, mandatory: true }),
    },
    index: [
        { name: 'x_daas_ham_cf_period', unique: false, element: 'billing_period' },
        { name: 'x_daas_ham_cf_customer', unique: false, element: 'customer' },
    ],
})

/** Subscription and fee revenue minus Cost facts, per Customer, Site and currency, for one Billing period (two currencies are never added). */
export const x_daas_ham_margin = Table({
    name: 'x_daas_ham_margin',
    label: 'Margin',
    schema: {
        billing_period: ReferenceColumn({ label: 'Billing period', referenceTable: 'x_daas_ham_billing_period', mandatory: true, cascadeRule: 'delete' }),
        customer: ReferenceColumn({ label: 'Customer', referenceTable: 'customer_account', mandatory: true }),
        site: ReferenceColumn({ label: 'Site (blank = customer-level fees and costs)', referenceTable: 'cmn_location' }),
        // A Customer and Site with amounts in two currencies get a row for each.
        currency: StringColumn({ label: 'Currency', maxLength: 3, mandatory: true }),
        revenue: DecimalColumn({ label: 'Revenue' }),
        cost: DecimalColumn({ label: 'Cost' }),
        margin: DecimalColumn({ label: 'Margin' }),
        margin_pct: DecimalColumn({ label: 'Margin %' }),
    },
    index: [
        { name: 'x_daas_ham_mg_period', unique: false, element: 'billing_period' },
        { name: 'x_daas_ham_mg_customer', unique: false, element: 'customer' },
    ],
})

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

Acl({
    $id: Now.ID['acl_cost_fact_read'],
    type: 'record',
    table: 'x_daas_ham_cost_fact',
    operation: 'read',
    roles: moneyReaders,
})

Acl({
    $id: Now.ID['acl_cost_fact_write'],
    type: 'record',
    table: 'x_daas_ham_cost_fact',
    operation: 'write',
    roles: [finance],
})

Acl({
    $id: Now.ID['acl_cost_fact_create'],
    type: 'record',
    table: 'x_daas_ham_cost_fact',
    operation: 'create',
    roles: [finance],
})

Acl({
    $id: Now.ID['acl_cost_fact_delete'],
    type: 'record',
    table: 'x_daas_ham_cost_fact',
    operation: 'delete',
    roles: [finance],
})

Acl({
    $id: Now.ID['acl_margin_read'],
    type: 'record',
    table: 'x_daas_ham_margin',
    operation: 'read',
    roles: moneyReaders,
})

Acl({
    $id: Now.ID['acl_margin_write'],
    type: 'record',
    table: 'x_daas_ham_margin',
    operation: 'write',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_margin_create'],
    type: 'record',
    table: 'x_daas_ham_margin',
    operation: 'create',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_margin_delete'],
    type: 'record',
    table: 'x_daas_ham_margin',
    operation: 'delete',
    roles: [admin],
})

Form({
    table: 'x_daas_ham_cost_fact',
    view: default_view,
    sections: [
        {
            caption: 'Cost fact',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'billing_period', type: 'table_field' }, { field: 'customer', type: 'table_field' }, { field: 'site', type: 'table_field' }],
                    rightElements: [{ field: 'cost_type', type: 'table_field' }, { field: 'amount', type: 'table_field' }, { field: 'currency', type: 'table_field' }],
                },
            ],
        },
    ],
})

Form({
    table: 'x_daas_ham_margin',
    view: default_view,
    sections: [
        {
            caption: 'Margin',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'billing_period', type: 'table_field' }, { field: 'customer', type: 'table_field' }, { field: 'site', type: 'table_field' }, { field: 'currency', type: 'table_field' }],
                    rightElements: [{ field: 'revenue', type: 'table_field' }, { field: 'cost', type: 'table_field' }, { field: 'margin', type: 'table_field' }, { field: 'margin_pct', type: 'table_field' }],
                },
            ],
        },
    ],
})

// One row per Customer, Site and currency: its amounts are in that currency.
List({ table: 'x_daas_ham_margin', view: default_view, columns: ['billing_period', 'customer', 'site', 'currency', 'revenue', 'cost', 'margin', 'margin_pct'] })
