import { IN_SERVICE_ON_ENDED_LINE, IN_SERVICE_UNBILLED } from '../../server/domain/billing'
import { INSTALLED_WITHOUT_COVERAGE } from '../../server/domain/coverage'
import { FLEET_INSTALLED, FLEET_IN_STAGE } from '../../server/domain/fleet'
import { OPEN_ORDERS_QUERY, ORDERS_AWAITING_APPROVAL_QUERY } from '../../server/domain/fulfilment'
import { INSTALLED_PAST_SUPPORT } from '../../server/domain/model-lifecycle'
import { OPEN_EXCEPTIONS_QUERY } from '../../server/domain/reconciliation'
import { SUBSCRIPTION_LINE_STATUS } from '../../server/domain/vocabulary'
import type { Session } from '../lib/session'
import type { Money, Source } from '../lib/sn'
import { AUDIENCE, listById, type Audience, type ListId } from './catalog'

/*
 * alm_hardware also holds the Provider IT's equipment (ADR 0016), so every source on it counts fleet assets only: its
 * filter holds the fleet condition in each ^NQ clause (a condition after ^NQ binds to the last clause only), which
 * catalog.test.ts checks.
 */

interface WidgetBase {
    /** Unique among all tabs' widgets. */
    id: string
    title: string
    source: Source
    /** Columns of the tab's 12-column grid; widgets flow in definition order. */
    span: 3 | 4 | 6 | 12
    /** The list of the rows this widget counts: same table, same filter. */
    drill?: ListId
    /** Who reads the widget's table, when not everyone the tab is offered to does and no `drill` list says so. */
    audience?: Audience
}

/**
 * What a widget draws, and so what it asks the Stats API: a count, a count by one field, or a sum of a Money. A sum is
 * always grouped by the Money's currency, so no widget adds two currencies.
 */
export type Widget = WidgetBase &
    (
        | { chart: 'score' }
        | { chart: 'bar' | 'barh' | 'donut'; by: string; top: number; others: boolean }
        | { chart: 'currencyBar'; sum: Money }
        | { chart: 'currencyMatrix'; by: string; sum: Money }
    )

export interface DashboardTab {
    /** The `?tab=` of the dashboard's address. */
    id: string
    title: string
    audience: Audience
    widgets: readonly Widget[]
}

const LAST_MONTH = 'billing_period.period_startONLast month@javascript:gs.beginningOfLastMonth()@javascript:gs.endOfLastMonth()'

export const DASHBOARD: readonly DashboardTab[] = [
    {
        id: 'operations',
        title: 'Operations',
        audience: 'staff',
        widgets: [
            {
                id: 'open_orders',
                chart: 'score',
                title: 'Open orders',
                span: 3,
                source: { table: 'x_daas_ham_order', filter: OPEN_ORDERS_QUERY },
                drill: 'orders_open',
            },
            {
                id: 'awaiting_approval',
                chart: 'score',
                title: 'Awaiting approval',
                span: 3,
                source: { table: 'x_daas_ham_order', filter: ORDERS_AWAITING_APPROVAL_QUERY },
                drill: 'orders_approval',
            },
            {
                id: 'open_staging',
                chart: 'score',
                title: 'Open staging tasks',
                span: 3,
                source: { table: 'x_daas_ham_staging_task', filter: 'active=true' },
                drill: 'staging_open',
            },
            {
                id: 'pending_in_service',
                chart: 'score',
                title: 'Installed, not yet seen',
                span: 3,
                source: { table: 'alm_hardware', filter: FLEET_IN_STAGE.pending_in_service },
                drill: 'assets_pending_in_service',
            },
            {
                id: 'orders_by_stage',
                chart: 'bar',
                by: 'stage',
                top: 10,
                others: false,
                title: 'Open orders by stage',
                span: 6,
                source: { table: 'x_daas_ham_order', filter: OPEN_ORDERS_QUERY },
                drill: 'orders_open',
            },
            {
                id: 'spares_by_customer',
                chart: 'barh',
                by: 'company',
                top: 15,
                others: true,
                title: 'Spare pool by customer',
                span: 6,
                source: { table: 'alm_hardware', filter: FLEET_IN_STAGE.spare_pool },
                drill: 'stock_spare_pools',
            },
        ],
    },
    {
        id: 'billing',
        title: 'Billing integrity',
        audience: 'staff',
        widgets: [
            {
                id: 'unbilled_in_service',
                chart: 'score',
                title: 'In service without a subscription line',
                span: 3,
                source: { table: 'alm_hardware', filter: IN_SERVICE_UNBILLED },
            },
            {
                id: 'ended_line_in_service',
                chart: 'score',
                title: 'In service on an ended line',
                span: 3,
                source: { table: 'alm_hardware', filter: IN_SERVICE_ON_ENDED_LINE },
            },
            {
                id: 'pending_lines',
                chart: 'score',
                title: 'Subscription lines not yet started',
                span: 3,
                source: { table: 'x_daas_ham_subscription_line', filter: `status=${SUBSCRIPTION_LINE_STATUS.pending}` },
                audience: 'broadStaff',
            },
            {
                id: 'lines_by_customer',
                chart: 'donut',
                by: 'customer',
                top: 10,
                others: true,
                title: 'Active subscription lines by customer',
                span: 3,
                source: { table: 'x_daas_ham_subscription_line', filter: `status=${SUBSCRIPTION_LINE_STATUS.active}` },
                audience: 'broadStaff',
            },
        ],
    },
    {
        id: 'risk',
        title: 'Lifecycle risk',
        audience: 'staff',
        widgets: [
            {
                id: 'past_support',
                chart: 'score',
                title: 'Installed past end of support',
                span: 3,
                source: { table: 'alm_hardware', filter: INSTALLED_PAST_SUPPORT },
                drill: 'risk_past_support',
            },
            {
                id: 'no_coverage',
                chart: 'score',
                title: 'Installed without OEM coverage',
                span: 3,
                source: { table: 'alm_hardware', filter: INSTALLED_WITHOUT_COVERAGE },
                drill: 'risk_no_coverage',
            },
            {
                id: 'open_exceptions',
                chart: 'score',
                title: 'Open reconciliation exceptions',
                span: 3,
                source: { table: 'x_daas_ham_recon_exception', filter: OPEN_EXCEPTIONS_QUERY },
                drill: 'exceptions_open',
            },
            {
                id: 'open_returns',
                chart: 'score',
                title: 'Open returns',
                span: 3,
                source: { table: 'x_daas_ham_return_order', filter: 'active=true' },
                drill: 'returns_open',
            },
            {
                id: 'phase',
                chart: 'bar',
                by: 'x_daas_ham_lifecycle_phase',
                top: 10,
                others: true,
                title: 'Installed base by lifecycle phase',
                span: 6,
                source: { table: 'alm_hardware', filter: FLEET_INSTALLED },
            },
            {
                id: 'exception_types',
                chart: 'donut',
                by: 'exception_type',
                top: 10,
                others: true,
                title: 'Open exceptions by type',
                span: 6,
                source: { table: 'x_daas_ham_recon_exception', filter: OPEN_EXCEPTIONS_QUERY },
                drill: 'exceptions_open',
            },
        ],
    },
    {
        id: 'margin',
        title: 'Margin',
        audience: 'money',
        widgets: [
            {
                id: 'revenue_last_month',
                chart: 'currencyBar',
                sum: { amount: 'revenue', currency: 'currency' },
                title: 'Revenue last month (per currency)',
                span: 4,
                source: { table: 'x_daas_ham_margin', filter: LAST_MONTH },
            },
            {
                id: 'cost_last_month',
                chart: 'currencyBar',
                sum: { amount: 'cost', currency: 'currency' },
                title: 'Cost last month (per currency)',
                span: 4,
                source: { table: 'x_daas_ham_margin', filter: LAST_MONTH },
            },
            {
                id: 'margin_last_month',
                chart: 'currencyBar',
                sum: { amount: 'margin', currency: 'currency' },
                title: 'Margin last month (per currency)',
                span: 4,
                source: { table: 'x_daas_ham_margin', filter: LAST_MONTH },
            },
            {
                id: 'margin_by_customer',
                chart: 'currencyMatrix',
                by: 'customer',
                sum: { amount: 'margin', currency: 'currency' },
                title: 'Margin by customer and currency (12 months)',
                span: 6,
                source: { table: 'x_daas_ham_margin', filter: 'billing_period.period_start>=javascript:gs.beginningOfLast12Months()' },
            },
            {
                id: 'cost_by_type',
                chart: 'currencyMatrix',
                by: 'cost_type',
                sum: { amount: 'amount', currency: 'currency' },
                title: 'Cost last month by type and currency',
                span: 6,
                source: { table: 'x_daas_ham_cost_fact', filter: LAST_MONTH },
            },
        ],
    },
]

/**
 * Who a widget is offered to within its tab: its own audience, else its drill list's, else the tab's. A widget on a
 * table some of the tab's roles cannot read would show them a failure, not a count.
 */
export function widgetAudience(tab: DashboardTab, widget: Widget): Audience {
    return widget.audience ?? (widget.drill && listById(widget.drill)?.audience) ?? tab.audience
}

/** The tabs `session` is offered, each with the widgets it is offered; a tab with none is left out. */
export function tabsFor(session: Session): readonly DashboardTab[] {
    return DASHBOARD.filter((tab) => session.holdsAny(AUDIENCE[tab.audience]))
        .map((tab) => ({ ...tab, widgets: tab.widgets.filter((widget) => session.holdsAny(AUDIENCE[widgetAudience(tab, widget)])) }))
        .filter((tab) => tab.widgets.length > 0)
}
