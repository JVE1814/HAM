import '@servicenow/sdk/global'
import { Dashboard } from '@servicenow/sdk/core'
import { naasWorkspace } from './workspace.now'

/* Workspace landing dashboard. Operations and billing-integrity KPIs (P1). */

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
    ],
    visibilities: [{ $id: Now.ID['dash_naas_visibility'], experience: naasWorkspace }],
    permissions: [],
})
