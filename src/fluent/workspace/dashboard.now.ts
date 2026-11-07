import '@servicenow/sdk/global'
import { Dashboard } from '@servicenow/sdk/core'
import { naasWorkspace } from './workspace.now'

/* Workspace landing dashboard: operations, billing integrity (P1), lifecycle risk (P2) and margin (P3). */

export const naasDashboard = Dashboard({
    $id: Now.ID['dash_naas'],
    name: 'NaaS Asset Overview',
    tabs: [
        {
            $id: Now.ID['dash_tab_operations'],
            name: 'Operations',
            widgets: [
                {
                    $id: Now.ID['dash_w_open_orders'],
                    component: 'single-score',
                    componentProps: {
                        dataSources: [
                            {
                                label: 'Order',
                                sourceType: 'table',
                                tableOrViewName: 'x_daas_ham_order',
                                filterQuery: 'stageNOT INcomplete,cancelled,rejected',
                                id: 'open_orders',
                            },
                        ],
                        headerTitle: 'Open orders',
                        metrics: [{ dataSource: 'open_orders', id: 'm_open_orders', aggregateFunction: 'COUNT', axisId: 'primary' }],
                    },
                    height: 12,
                    width: 12,
                    position: { x: 0, y: 0 },
                },
                {
                    $id: Now.ID['dash_w_awaiting_approval'],
                    component: 'single-score',
                    componentProps: {
                        dataSources: [
                            {
                                label: 'Order',
                                sourceType: 'table',
                                tableOrViewName: 'x_daas_ham_order',
                                filterQuery: 'stage=awaiting_approval',
                                id: 'awaiting_approval',
                            },
                        ],
                        headerTitle: 'Awaiting approval',
                        metrics: [{ dataSource: 'awaiting_approval', id: 'm_awaiting_approval', aggregateFunction: 'COUNT', axisId: 'primary' }],
                    },
                    height: 12,
                    width: 12,
                    position: { x: 12, y: 0 },
                },
                {
                    $id: Now.ID['dash_w_open_staging'],
                    component: 'single-score',
                    componentProps: {
                        dataSources: [
                            {
                                label: 'Staging task',
                                sourceType: 'table',
                                tableOrViewName: 'x_daas_ham_staging_task',
                                filterQuery: 'active=true',
                                id: 'open_staging',
                            },
                        ],
                        headerTitle: 'Open staging tasks',
                        metrics: [{ dataSource: 'open_staging', id: 'm_open_staging', aggregateFunction: 'COUNT', axisId: 'primary' }],
                    },
                    height: 12,
                    width: 12,
                    position: { x: 24, y: 0 },
                },
                {
                    $id: Now.ID['dash_w_pending_in_service'],
                    component: 'single-score',
                    componentProps: {
                        dataSources: [
                            {
                                label: 'Hardware',
                                sourceType: 'table',
                                tableOrViewName: 'alm_hardware',
                                filterQuery: 'install_status=1^substatus=pending_in_service',
                                id: 'pending_in_service',
                            },
                        ],
                        headerTitle: 'Installed, not yet seen',
                        metrics: [{ dataSource: 'pending_in_service', id: 'm_pending_in_service', aggregateFunction: 'COUNT', axisId: 'primary' }],
                    },
                    height: 12,
                    width: 12,
                    position: { x: 36, y: 0 },
                },
                {
                    $id: Now.ID['dash_w_orders_by_stage'],
                    component: 'vertical-bar',
                    componentProps: {
                        dataSources: [
                            {
                                label: 'Order',
                                sourceType: 'table',
                                tableOrViewName: 'x_daas_ham_order',
                                filterQuery: 'stageNOT INcomplete,cancelled,rejected',
                                id: 'orders_by_stage',
                            },
                        ],
                        headerTitle: 'Open orders by stage',
                        metrics: [{ dataSource: 'orders_by_stage', id: 'm_orders_by_stage', aggregateFunction: 'COUNT', axisId: 'primary' }],
                        groupBy: [{ groupBy: [{ dataSource: 'orders_by_stage', groupByField: 'stage' }], maxNumberOfGroups: 10, showOthers: false }],
                        sortBy: 'value',
                    },
                    height: 16,
                    width: 24,
                    position: { x: 0, y: 12 },
                },
                {
                    $id: Now.ID['dash_w_spares_by_customer'],
                    component: 'horizontal-bar',
                    componentProps: {
                        dataSources: [
                            {
                                label: 'Hardware',
                                sourceType: 'table',
                                tableOrViewName: 'alm_hardware',
                                filterQuery: 'install_status=6^substatus=reserved_spare_pool',
                                id: 'spares_by_customer',
                            },
                        ],
                        headerTitle: 'Spare pool by customer',
                        metrics: [{ dataSource: 'spares_by_customer', id: 'm_spares_by_customer', aggregateFunction: 'COUNT', axisId: 'primary' }],
                        groupBy: [{ groupBy: [{ dataSource: 'spares_by_customer', groupByField: 'company' }], maxNumberOfGroups: 15, showOthers: true }],
                        sortBy: 'value',
                    },
                    height: 16,
                    width: 24,
                    position: { x: 24, y: 12 },
                },
            ],
        },
        {
            $id: Now.ID['dash_tab_billing'],
            name: 'Billing integrity',
            widgets: [
                {
                    $id: Now.ID['dash_w_unbilled_in_service'],
                    component: 'single-score',
                    componentProps: {
                        dataSources: [
                            {
                                label: 'Hardware',
                                sourceType: 'table',
                                tableOrViewName: 'alm_hardware',
                                filterQuery: 'install_status=1^substatusISEMPTY^x_daas_ham_subscription_lineISEMPTY',
                                id: 'unbilled',
                            },
                        ],
                        headerTitle: 'In service without a subscription line',
                        metrics: [{ dataSource: 'unbilled', id: 'm_unbilled', aggregateFunction: 'COUNT', axisId: 'primary' }],
                    },
                    height: 12,
                    width: 16,
                    position: { x: 0, y: 0 },
                },
                {
                    $id: Now.ID['dash_w_pending_lines'],
                    component: 'single-score',
                    componentProps: {
                        dataSources: [
                            {
                                label: 'Subscription line',
                                sourceType: 'table',
                                tableOrViewName: 'x_daas_ham_subscription_line',
                                filterQuery: 'status=pending',
                                id: 'pending_lines',
                            },
                        ],
                        headerTitle: 'Subscription lines not yet started',
                        metrics: [{ dataSource: 'pending_lines', id: 'm_pending_lines', aggregateFunction: 'COUNT', axisId: 'primary' }],
                    },
                    height: 12,
                    width: 16,
                    position: { x: 16, y: 0 },
                },
                {
                    $id: Now.ID['dash_w_lines_by_customer'],
                    component: 'donut',
                    componentProps: {
                        dataSources: [
                            {
                                label: 'Subscription line',
                                sourceType: 'table',
                                tableOrViewName: 'x_daas_ham_subscription_line',
                                filterQuery: 'status=active',
                                id: 'lines_by_customer',
                            },
                        ],
                        headerTitle: 'Active subscription lines by customer',
                        metrics: [{ dataSource: 'lines_by_customer', id: 'm_lines_by_customer', aggregateFunction: 'COUNT', axisId: 'primary' }],
                        groupBy: [{ groupBy: [{ dataSource: 'lines_by_customer', groupByField: 'customer' }], maxNumberOfGroups: 10, showOthers: true }],
                    },
                    height: 16,
                    width: 16,
                    position: { x: 32, y: 0 },
                },
            ],
        },
        {
            $id: Now.ID['dash_tab_risk'],
            name: 'Lifecycle risk',
            widgets: [
                {
                    $id: Now.ID['dash_w_past_support'],
                    component: 'single-score',
                    componentProps: {
                        dataSources: [{ label: 'alm_hardware', sourceType: 'table', tableOrViewName: 'alm_hardware', filterQuery: 'install_status=1^x_daas_ham_lifecycle_phaseINend_of_support,end_of_extended_support,end_of_life', id: 'dash_w_past_support_ds' }],
                        headerTitle: 'Installed past end of support',
                        metrics: [{ dataSource: 'dash_w_past_support_ds', id: 'dash_w_past_support_m', aggregateFunction: 'COUNT', axisId: 'primary' }],
                    },
                    height: 12,
                    width: 12,
                    position: { x: 0, y: 0 },
                },
                {
                    $id: Now.ID['dash_w_no_coverage'],
                    component: 'single-score',
                    componentProps: {
                        dataSources: [{ label: 'alm_hardware', sourceType: 'table', tableOrViewName: 'alm_hardware', filterQuery: 'install_status=1^x_daas_ham_coverage_endISEMPTY', id: 'dash_w_no_coverage_ds' }],
                        headerTitle: 'Installed without OEM coverage',
                        metrics: [{ dataSource: 'dash_w_no_coverage_ds', id: 'dash_w_no_coverage_m', aggregateFunction: 'COUNT', axisId: 'primary' }],
                    },
                    height: 12,
                    width: 12,
                    position: { x: 12, y: 0 },
                },
                {
                    $id: Now.ID['dash_w_open_exceptions'],
                    component: 'single-score',
                    componentProps: {
                        dataSources: [{ label: 'x_daas_ham_recon_exception', sourceType: 'table', tableOrViewName: 'x_daas_ham_recon_exception', filterQuery: 'status=open', id: 'dash_w_open_exceptions_ds' }],
                        headerTitle: 'Open reconciliation exceptions',
                        metrics: [{ dataSource: 'dash_w_open_exceptions_ds', id: 'dash_w_open_exceptions_m', aggregateFunction: 'COUNT', axisId: 'primary' }],
                    },
                    height: 12,
                    width: 12,
                    position: { x: 24, y: 0 },
                },
                {
                    $id: Now.ID['dash_w_open_returns'],
                    component: 'single-score',
                    componentProps: {
                        dataSources: [{ label: 'x_daas_ham_return_order', sourceType: 'table', tableOrViewName: 'x_daas_ham_return_order', filterQuery: 'active=true', id: 'dash_w_open_returns_ds' }],
                        headerTitle: 'Open returns',
                        metrics: [{ dataSource: 'dash_w_open_returns_ds', id: 'dash_w_open_returns_m', aggregateFunction: 'COUNT', axisId: 'primary' }],
                    },
                    height: 12,
                    width: 12,
                    position: { x: 36, y: 0 },
                },
                {
                    $id: Now.ID['dash_w_phase'],
                    component: 'vertical-bar',
                    componentProps: {
                        dataSources: [{ label: 'alm_hardware', sourceType: 'table', tableOrViewName: 'alm_hardware', filterQuery: 'install_status=1', id: 'dash_w_phase_ds' }],
                        headerTitle: 'Installed base by lifecycle phase',
                        metrics: [{ dataSource: 'dash_w_phase_ds', id: 'dash_w_phase_m', aggregateFunction: 'COUNT', axisId: 'primary' }],
                        groupBy: [{ groupBy: [{ dataSource: 'dash_w_phase_ds', groupByField: 'x_daas_ham_lifecycle_phase' }], maxNumberOfGroups: 10, showOthers: true }],
                    },
                    height: 16,
                    width: 24,
                    position: { x: 0, y: 12 },
                },
                {
                    $id: Now.ID['dash_w_exception_types'],
                    component: 'donut',
                    componentProps: {
                        dataSources: [{ label: 'x_daas_ham_recon_exception', sourceType: 'table', tableOrViewName: 'x_daas_ham_recon_exception', filterQuery: 'status=open', id: 'dash_w_exception_types_ds' }],
                        headerTitle: 'Open exceptions by type',
                        metrics: [{ dataSource: 'dash_w_exception_types_ds', id: 'dash_w_exception_types_m', aggregateFunction: 'COUNT', axisId: 'primary' }],
                        groupBy: [{ groupBy: [{ dataSource: 'dash_w_exception_types_ds', groupByField: 'exception_type' }], maxNumberOfGroups: 10, showOthers: true }],
                    },
                    height: 16,
                    width: 24,
                    position: { x: 24, y: 12 },
                },
            ],
        },
        {
            $id: Now.ID['dash_tab_margin'],
            name: 'Margin',
            widgets: [
                {
                    $id: Now.ID['dash_w_revenue_last_month'],
                    component: 'single-score',
                    componentProps: {
                        dataSources: [{ label: 'Revenue last month', sourceType: 'table', tableOrViewName: 'x_daas_ham_margin', filterQuery: 'billing_period.period_startONLast month@javascript:gs.beginningOfLastMonth()@javascript:gs.endOfLastMonth()', id: 'dash_w_revenue_last_month_ds' }],
                        headerTitle: 'Revenue last month',
                        metrics: [{ dataSource: 'dash_w_revenue_last_month_ds', id: 'dash_w_revenue_last_month_m', aggregateFunction: 'SUM', field: 'revenue', axisId: 'primary' }],
                    },
                    height: 12,
                    width: 16,
                    position: { x: 0, y: 0 },
                },
                {
                    $id: Now.ID['dash_w_cost_last_month'],
                    component: 'single-score',
                    componentProps: {
                        dataSources: [{ label: 'Cost last month', sourceType: 'table', tableOrViewName: 'x_daas_ham_margin', filterQuery: 'billing_period.period_startONLast month@javascript:gs.beginningOfLastMonth()@javascript:gs.endOfLastMonth()', id: 'dash_w_cost_last_month_ds' }],
                        headerTitle: 'Cost last month',
                        metrics: [{ dataSource: 'dash_w_cost_last_month_ds', id: 'dash_w_cost_last_month_m', aggregateFunction: 'SUM', field: 'cost', axisId: 'primary' }],
                    },
                    height: 12,
                    width: 16,
                    position: { x: 16, y: 0 },
                },
                {
                    $id: Now.ID['dash_w_margin_last_month'],
                    component: 'single-score',
                    componentProps: {
                        dataSources: [{ label: 'Margin last month', sourceType: 'table', tableOrViewName: 'x_daas_ham_margin', filterQuery: 'billing_period.period_startONLast month@javascript:gs.beginningOfLastMonth()@javascript:gs.endOfLastMonth()', id: 'dash_w_margin_last_month_ds' }],
                        headerTitle: 'Margin last month',
                        metrics: [{ dataSource: 'dash_w_margin_last_month_ds', id: 'dash_w_margin_last_month_m', aggregateFunction: 'SUM', field: 'margin', axisId: 'primary' }],
                    },
                    height: 12,
                    width: 16,
                    position: { x: 32, y: 0 },
                },
                {
                    $id: Now.ID['dash_w_margin_by_customer'],
                    component: 'horizontal-bar',
                    componentProps: {
                        dataSources: [{ label: 'Margin', sourceType: 'table', tableOrViewName: 'x_daas_ham_margin', filterQuery: 'billing_period.period_start>=javascript:gs.beginningOfLast12Months()', id: 'dash_w_margin_by_customer_ds' }],
                        headerTitle: 'Margin by customer (12 months)',
                        metrics: [{ dataSource: 'dash_w_margin_by_customer_ds', id: 'dash_w_margin_by_customer_m', aggregateFunction: 'SUM', field: 'margin', axisId: 'primary' }],
                        groupBy: [{ groupBy: [{ dataSource: 'dash_w_margin_by_customer_ds', groupByField: 'customer' }], maxNumberOfGroups: 15, showOthers: true }],
                        sortBy: 'value',
                    },
                    height: 16,
                    width: 24,
                    position: { x: 0, y: 12 },
                },
                {
                    $id: Now.ID['dash_w_cost_by_type'],
                    component: 'donut',
                    componentProps: {
                        dataSources: [{ label: 'Cost fact', sourceType: 'table', tableOrViewName: 'x_daas_ham_cost_fact', filterQuery: 'billing_period.period_startONLast month@javascript:gs.beginningOfLastMonth()@javascript:gs.endOfLastMonth()', id: 'dash_w_cost_by_type_ds' }],
                        headerTitle: 'Cost last month by type',
                        metrics: [{ dataSource: 'dash_w_cost_by_type_ds', id: 'dash_w_cost_by_type_m', aggregateFunction: 'SUM', field: 'amount', axisId: 'primary' }],
                        groupBy: [{ groupBy: [{ dataSource: 'dash_w_cost_by_type_ds', groupByField: 'cost_type', isChoice: true }], maxNumberOfGroups: 10, showOthers: false }],
                    },
                    height: 16,
                    width: 24,
                    position: { x: 24, y: 12 },
                },
            ],
        },
    ],
    visibilities: [{ $id: Now.ID['dash_naas_visibility'], experience: naasWorkspace }],
    permissions: [],
})
