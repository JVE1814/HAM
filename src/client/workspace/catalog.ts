import { ENDED_LINES_WITHOUT_END_DATE, IN_SERVICE_ON_PENDING_LINE } from '../../server/domain/billing'
import { splitOrder, type Ordering } from '../../server/domain/encoded-query'
import { INSTALLED_WITHOUT_COVERAGE } from '../../server/domain/coverage'
import { FLEET_CONDITION, FLEET_INSTALLED, FLEET_IN_STAGE, INSTALLED_CONDITION, NAAS_MODEL_CONDITION, NAAS_MODEL_MILESTONES } from '../../server/domain/fleet'
import { OPEN_ORDERS_QUERY, ORDERS_AWAITING_APPROVAL_QUERY } from '../../server/domain/fulfilment'
import { INSTALLED_PAST_SUPPORT } from '../../server/domain/model-lifecycle'
import { OPEN_NORM_EXCEPTIONS_QUERY } from '../../server/domain/normalization'
import { OPEN_RMAS_QUERY } from '../../server/domain/oem-rma'
import { PROPERTY } from '../../server/domain/properties'
import { STEP_STATUS } from '../../server/domain/oem/claims'
import { OPEN_EXCEPTIONS_QUERY } from '../../server/domain/reconciliation'
import { OPEN_FEES_QUERY } from '../../server/domain/returns'
import { OPEN_SHIPMENTS } from '../../server/domain/shipping'
import { DISPOSAL_STAGE, INSTALL_STATUS, LINE_STAGE, ORDER_STAGE, ORDER_TYPE, RETURN_LINE_STATUS, SHIPMENT_STATUS, SUBSCRIPTION_LINE_STATUS } from '../../server/domain/vocabulary'
import { BROAD_STAFF, MONEY_READERS, PROVIDER_STAFF, ROLE, type AppRole } from '../../server/domain/roles'
import type { Session } from '../lib/session'
import type { Source } from '../lib/sn'

/*
 * The platform tables are shared with the Provider's IT (ADR 0016): a list on alm_hardware shows fleet assets only (its
 * condition holds the fleet condition in each ^NQ clause) and one on cmdb_model NaaS Models only, which catalog.test.ts
 * checks for any search and sort a user picks.
 */

/**
 * Who a list or a dashboard tab is offered to. It decides what the sidebar and the tabs offer, never what a list shows:
 * the ACLs and the before-query rules (ADR 0005) do that.
 */
export const AUDIENCE = {
    /** Every provider-staff role, for the tables inventory techs also read, and the platform's cmdb_model. */
    staff: PROVIDER_STAFF,
    broadStaff: BROAD_STAFF,
    money: MONEY_READERS,
    admin: [ROLE.admin],
} as const satisfies Record<string, readonly AppRole[]>

export type Audience = keyof typeof AUDIENCE

interface ListSource {
    title: string
    table: string
    /** An encoded query: conditions, then the list's own order (ORDERBY terms). */
    query: string
    /** Comma list, dot-walks allowed. */
    columns: string
    audience: Audience
}

const ORDER_COLUMNS = 'number,customer,site,order_type,stage,entitlement_verdict,install_mode,requested_date'

const INSTALLED_ASSET_COLUMNS = 'asset_tag,serial_number,model,company,x_daas_ham_site,install_status,substatus,x_daas_ham_last_seen'

/** Category title, then list id, then list; key order is the sidebar's order. */
const CATALOG = {
    Orders: {
        orders_open: {
            title: 'Open orders',
            table: 'x_daas_ham_order',
            query: `${OPEN_ORDERS_QUERY}^ORDERBYDESCsys_created_on`,
            columns: ORDER_COLUMNS,
            audience: 'staff',
        },
        orders_approval: {
            title: 'Awaiting approval',
            table: 'x_daas_ham_order',
            query: ORDERS_AWAITING_APPROVAL_QUERY,
            columns: ORDER_COLUMNS,
            audience: 'staff',
        },
        orders_to_ship: {
            title: 'Ready to ship',
            table: 'x_daas_ham_order',
            query: `stage=${ORDER_STAGE.delivering}`,
            columns: ORDER_COLUMNS,
            audience: 'staff',
        },
        orders_installing: {
            title: 'Installing',
            table: 'x_daas_ham_order',
            query: `stage=${ORDER_STAGE.installing}`,
            columns: ORDER_COLUMNS,
            audience: 'staff',
        },
        orders_all: {
            title: 'All orders',
            table: 'x_daas_ham_order',
            query: 'ORDERBYDESCsys_created_on',
            columns: ORDER_COLUMNS,
            audience: 'staff',
        },
    },
    Fulfilment: {
        lines_awaiting_stock: {
            title: 'Lines awaiting stock',
            table: 'x_daas_ham_order_line',
            query: `line_stage=${LINE_STAGE.awaiting_stock}`,
            columns: 'number,order,model,quantity,quantity_allocated,quantity_to_purchase,purchase_order,purchase_orders',
            audience: 'staff',
        },
        staging_open: {
            title: 'Open staging tasks',
            table: 'x_daas_ham_staging_task',
            query: 'active=true',
            columns: 'number,asset,staging_source,template,assigned_to,state,opened_at',
            audience: 'staff',
        },
        staging_mine: {
            title: 'My staging tasks',
            table: 'x_daas_ham_staging_task',
            query: 'active=true^assigned_toDYNAMIC90d1921e5f510100a9ad2572f2b477fe',
            columns: 'number,asset,staging_source,template,state,opened_at',
            audience: 'staff',
        },
        claims_failed: {
            title: 'OEM claims to do by hand',
            table: 'x_daas_ham_staging_step',
            query: `automation_status=${STEP_STATUS.failed}^done=false^staging_task.active=true^ORDERBYDESCsys_updated_on`,
            columns: 'staging_task,label,automation,automation_message,attempts',
            audience: 'staff',
        },
        shipments_open: {
            title: 'Shipments under way',
            table: 'x_daas_ham_shipment',
            query: `${OPEN_SHIPMENTS}^ORDERBYestimated_delivery`,
            columns: 'number,direction,customer,site,carrier,tracking_number,status,status_detail,estimated_delivery',
            audience: 'staff',
        },
        shipments_exception: {
            title: 'Shipment exceptions',
            table: 'x_daas_ham_shipment',
            query: `statusIN${SHIPMENT_STATUS.exception},${SHIPMENT_STATUS.returned},${SHIPMENT_STATUS.unknown}^ORDERBYDESCsys_updated_on`,
            columns: 'number,direction,customer,site,carrier,tracking_number,status,status_detail',
            audience: 'staff',
        },
    },
    'Installed base': {
        assets_in_service: {
            title: 'In service',
            table: 'alm_hardware',
            query: FLEET_IN_STAGE.in_service,
            columns: `${INSTALLED_ASSET_COLUMNS},x_daas_ham_in_service_date,x_daas_ham_refresh_due`,
            audience: 'staff',
        },
        assets_pending_in_service: {
            title: 'Installed, not yet seen',
            table: 'alm_hardware',
            query: FLEET_IN_STAGE.pending_in_service,
            columns: `${INSTALLED_ASSET_COLUMNS},x_daas_ham_install_completed`,
            audience: 'staff',
        },
        assets_refresh_due: {
            title: `Refresh due within ${PROPERTY.refreshHorizonDays.default} days`,
            table: 'alm_hardware',
            query: `x_daas_ham_refresh_dueRELATIVELT@dayofweek@ahead@${PROPERTY.refreshHorizonDays.default}^${FLEET_INSTALLED}`,
            columns: `${INSTALLED_ASSET_COLUMNS},x_daas_ham_refresh_due,x_daas_ham_lifecycle_phase`,
            audience: 'staff',
        },
        assets_missing: {
            title: 'Missing',
            table: 'alm_hardware',
            query: `install_status=${INSTALL_STATUS.missing}^${FLEET_CONDITION}`,
            columns: INSTALLED_ASSET_COLUMNS,
            audience: 'staff',
        },
        assets_data_gaps: {
            title: 'Data gaps (no tag, serial, agreement or site)',
            table: 'alm_hardware',
            query: `${INSTALLED_CONDITION}^asset_tagISEMPTY^ORserial_numberISEMPTY^ORx_daas_ham_agreementISEMPTY^ORx_daas_ham_siteISEMPTY^${FLEET_CONDITION}`,
            columns: `${INSTALLED_ASSET_COLUMNS},x_daas_ham_agreement`,
            audience: 'broadStaff',
        },
    },
    'After-sales': {
        replacements_open: {
            title: 'Open replacement orders',
            table: 'x_daas_ham_order',
            query: `order_type=${ORDER_TYPE.device_replace}^${OPEN_ORDERS_QUERY}`,
            columns: 'number,customer,site,stage,install_mode',
            audience: 'staff',
        },
        refresh_open: {
            title: 'Open refresh orders',
            table: 'x_daas_ham_order',
            query: `order_type=${ORDER_TYPE.refresh}^${OPEN_ORDERS_QUERY}`,
            columns: 'number,customer,site,stage,sys_created_on',
            audience: 'staff',
        },
        returns_open: {
            title: 'Open returns',
            table: 'x_daas_ham_return_order',
            query: 'active=true',
            columns: 'number,trigger,customer,site,method,due_back,escalated',
            audience: 'staff',
        },
        returns_overdue: {
            title: 'Overdue returns',
            table: 'x_daas_ham_return_order',
            query: 'active=true^due_back<javascript:gs.beginningOfToday()',
            columns: 'number,trigger,customer,site,due_back,escalated',
            audience: 'staff',
        },
        returns_to_evaluate: {
            title: 'Returned, awaiting evaluation',
            table: 'x_daas_ham_return_order_line',
            query: `status=${RETURN_LINE_STATUS.received}`,
            columns: 'return_order,asset,received_at,condition,evaluation',
            audience: 'staff',
        },
        oem_rmas: {
            title: 'Open OEM RMAs',
            table: 'x_daas_ham_oem_rma',
            query: OPEN_RMAS_QUERY,
            columns: 'rma_number,vendor,state,status,defective_asset,ship_back_due',
            audience: 'staff',
        },
        disposals: {
            title: 'Disposal orders',
            table: 'x_daas_ham_disposal_order',
            query: `stage!=${DISPOSAL_STAGE.completed}`,
            columns: 'number,method,disposal_vendor,stage,approval',
            audience: 'staff',
        },
        fees_open: {
            title: 'Open fee events',
            table: 'x_daas_ham_fee_event',
            query: OPEN_FEES_QUERY,
            columns: 'occurred_on,fee_type,customer,asset,amount,agreement.currency',
            audience: 'broadStaff',
        },
    },
    Stock: {
        stock_available: {
            title: 'Available stock',
            table: 'alm_hardware',
            query: FLEET_IN_STAGE.available,
            columns: 'asset_tag,serial_number,model,stockroom,x_daas_ham_staging_source',
            audience: 'staff',
        },
        stock_spare_pools: {
            title: 'Spare pools',
            table: 'alm_hardware',
            query: FLEET_IN_STAGE.spare_pool,
            columns: 'asset_tag,serial_number,model,company,stockroom',
            audience: 'staff',
        },
        stock_in_transit: {
            title: 'In transit from distributors',
            table: 'alm_hardware',
            query: FLEET_IN_STAGE.in_transit,
            columns: 'serial_number,model,po_number,x_daas_ham_staging_source,sys_created_on',
            audience: 'staff',
        },
    },
    Assurance: {
        audits_open: {
            title: 'Open audits',
            table: 'x_daas_ham_audit',
            query: 'active=true',
            columns: 'number,audit_type,stockroom,site,expected_count,state',
            audience: 'staff',
        },
        exceptions_open: {
            title: 'Open reconciliation exceptions',
            table: 'x_daas_ham_recon_exception',
            query: `${OPEN_EXCEPTIONS_QUERY}^ORDERBYDESCdetected_at`,
            columns: 'detected_at,exception_type,asset,ci,customer,detail',
            audience: 'broadStaff',
        },
        attestations_open: {
            title: 'Open attestations',
            table: 'x_daas_ham_attestation',
            query: 'active=true',
            columns: 'number,customer,site,assigned_to,opened_at',
            audience: 'broadStaff',
        },
        risk_past_support: {
            title: 'Installed past end of support',
            table: 'alm_hardware',
            query: INSTALLED_PAST_SUPPORT,
            columns: 'asset_tag,serial_number,model,company,x_daas_ham_site,x_daas_ham_lifecycle_phase,x_daas_ham_refresh_due',
            audience: 'staff',
        },
        risk_no_coverage: {
            title: 'Installed without OEM coverage',
            table: 'alm_hardware',
            query: INSTALLED_WITHOUT_COVERAGE,
            columns: 'asset_tag,serial_number,model,company,x_daas_ham_site,x_daas_ham_coverage_end,x_daas_ham_coverage_checked',
            audience: 'staff',
        },
        coverage: {
            title: 'OEM coverage contracts',
            table: 'x_daas_ham_oem_coverage',
            query: 'ORDERBYend_date',
            columns: 'serial_number,asset,vendor,service_level,end_date,covered,source',
            audience: 'broadStaff',
        },
        coverage_expiring: {
            title: 'OEM coverage expiring',
            table: 'x_daas_ham_oem_coverage',
            query: 'covered=true^expiry_notified=true^end_date>=javascript:gs.beginningOfToday()^ORDERBYend_date',
            columns: 'serial_number,asset,asset.company,vendor,service_level,end_date',
            audience: 'broadStaff',
        },
    },
    Models: {
        models_canonical: {
            title: 'Canonical models',
            table: 'cmdb_model',
            query: NAAS_MODEL_CONDITION,
            columns: 'display_name,manufacturer,x_daas_ham_oem_pid,x_daas_ham_device_class,asset_tracking_strategy',
            audience: 'staff',
        },
        models_lifecycle: {
            title: 'Model lifecycle',
            table: 'cmdb_model_lifecycle',
            query: NAAS_MODEL_MILESTONES,
            columns: 'model,lifecycle_phase,start_date,source,description,sys_updated_on',
            audience: 'broadStaff',
        },
        models_exceptions: {
            title: 'Normalization exceptions',
            table: 'x_daas_ham_norm_exception',
            query: `${OPEN_NORM_EXCEPTIONS_QUERY}^ORDERBYDESCoccurrences`,
            columns: 'raw_manufacturer,raw_model,reason,occurrences,resolved_model',
            audience: 'broadStaff',
        },
        models_rules: {
            title: 'Match rules',
            table: 'x_daas_ham_model_match_rule',
            query: 'ORDERBYorder',
            columns: 'order,manufacturer,match_type,pattern,model,active',
            audience: 'broadStaff',
        },
    },
    Commercial: {
        agreements: {
            title: 'Agreements',
            table: 'x_daas_ham_agreement',
            query: 'ORDERBYcustomer',
            columns: 'number,customer,account_manager,state,currency,starts,ends,replacement_tier,refresh_cycle_months',
            audience: 'broadStaff',
        },
        subscription_lines: {
            title: 'Subscription lines',
            table: 'x_daas_ham_subscription_line',
            query: `status!=${SUBSCRIPTION_LINE_STATUS.ended}`,
            columns: 'description,customer,agreement,line_type,site,device_class,monthly_rate,status,start_date',
            audience: 'broadStaff',
        },
        lines_ended_no_end_date: {
            title: 'Ended lines without an end date',
            table: 'x_daas_ham_subscription_line',
            query: ENDED_LINES_WITHOUT_END_DATE,
            columns: 'description,customer,agreement,line_type,site,monthly_rate,status,start_date,end_date',
            audience: 'broadStaff',
        },
        catalog_entries: {
            title: 'Catalog entries',
            table: 'x_daas_ham_catalog_entry',
            query: 'active=true',
            columns: 'customer,entry_type,model,site_template,monthly_rate,valid_to',
            audience: 'broadStaff',
        },
        site_templates: {
            title: 'Site templates',
            table: 'x_daas_ham_site_template',
            query: 'active=true',
            columns: 'name,customer,description',
            audience: 'broadStaff',
        },
        lease_schedules: {
            title: 'Lease schedules',
            table: 'x_daas_ham_lease_schedule',
            query: 'ORDERBYends',
            columns: 'number,vendor,vendor_contract,ends,monthly_payment,buyout_price,end_action,mismatch',
            audience: 'broadStaff',
        },
        lease_decisions: {
            title: 'End-of-lease decisions',
            table: 'x_daas_ham_lease_decision',
            query: 'active=true^ORDERBYlease_end',
            columns: 'number,lease,lease_end,decision,covered_assets,deployed_assets,mismatch,assigned_to',
            audience: 'broadStaff',
        },
        agreements_renewal: {
            title: 'Agreements up for renewal',
            table: 'x_daas_ham_agreement',
            query: 'renewal_notified=true^ends>=javascript:gs.beginningOfToday()^ORDERBYends',
            columns: 'number,customer,account_manager,ends,renewal_term_months',
            audience: 'broadStaff',
        },
    },
    Billing: {
        billing_periods: {
            title: 'Billing periods',
            table: 'x_daas_ham_billing_period',
            query: 'ORDERBYDESCperiod',
            columns: 'period,status,line_count,totals,total_amount,generated_at,closed_at,closed_by',
            audience: 'money',
        },
        billing_lines: {
            title: 'Billing lines',
            table: 'x_daas_ham_billing_line',
            query: 'ORDERBYDESCsys_created_on',
            columns: 'billing_period,kind,customer,site,description,units,monthly_rate,amount,currency',
            audience: 'money',
        },
        // Its Billing period column reads a money table; the other broad staff find the same fees under Open fee events.
        fees_unbilled: {
            title: 'Unbilled fees',
            table: 'x_daas_ham_fee_event',
            query: `${OPEN_FEES_QUERY}^ORDERBYoccurred_on`,
            columns: 'fee_type,customer,asset,return_order,amount,agreement.currency,occurred_on,billing_period',
            audience: 'money',
        },
        service_intervals: {
            title: 'Open service intervals',
            table: 'x_daas_ham_service_interval',
            query: 'end_dateISEMPTY^ORDERBYstart_date',
            columns: 'asset,subscription_line,customer,site,start_date,end_date',
            audience: 'money',
        },
        // Its filter reads the line's status, so it is offered to the roles that read Subscription lines.
        assets_on_pending_line: {
            title: 'In service on a line not yet started',
            table: 'alm_hardware',
            query: IN_SERVICE_ON_PENDING_LINE,
            columns: `${INSTALLED_ASSET_COLUMNS},x_daas_ham_subscription_line`,
            audience: 'broadStaff',
        },
        margin: {
            title: 'Margin by customer and site',
            table: 'x_daas_ham_margin',
            query: 'ORDERBYDESCbilling_period.period^ORDERBYmargin',
            columns: 'billing_period,customer,site,currency,revenue,cost,margin,margin_pct',
            audience: 'money',
        },
        cost_facts: {
            title: 'Cost facts',
            table: 'x_daas_ham_cost_fact',
            query: 'ORDERBYDESCbilling_period.period',
            columns: 'billing_period,customer,site,cost_type,amount,currency',
            audience: 'money',
        },
    },
    Administration: {
        cloud_accounts: {
            title: 'OEM cloud accounts',
            table: 'x_daas_ham_cloud_account',
            query: 'ORDERBYcustomer',
            columns: 'customer,vendor,purpose,account_id',
            audience: 'broadStaff',
        },
        admin_jobs: {
            title: 'Background job cursors',
            table: 'x_daas_ham_job_cursor',
            query: '',
            columns: 'job,cursor,last_run,last_status,processed_total,failed_total,last_error',
            audience: 'admin',
        },
    },
} as const satisfies Record<string, Record<string, ListSource>>

type Lists = typeof CATALOG
export type ListId = { [C in keyof Lists]: keyof Lists[C] & string }[keyof Lists]

export interface WorkspaceList extends Source {
    id: ListId
    title: string
    /** The order when the user picked none. */
    order: readonly Ordering[]
    columns: readonly string[]
    audience: Audience
}

export interface Category {
    title: string
    lists: readonly WorkspaceList[]
}

export const CATEGORIES: readonly Category[] = Object.entries(CATALOG).map(([title, lists]) => ({
    title,
    lists: Object.entries(lists).map(([id, list]: [string, ListSource]): WorkspaceList => {
        const { filter, order } = splitOrder(list.query)
        return { id: id as ListId, title: list.title, table: list.table, filter, order, columns: list.columns.split(','), audience: list.audience }
    }),
}))

const BY_ID = new Map<string, WorkspaceList>(CATEGORIES.flatMap((category) => category.lists.map((list) => [list.id, list])))

export function listById(id: string): WorkspaceList | undefined {
    return BY_ID.get(id)
}

/** The categories and lists `session` is offered; a category with none is left out. */
export function menuFor(session: Session): readonly Category[] {
    return CATEGORIES.map((category) => ({ ...category, lists: category.lists.filter((list) => session.holdsAny(AUDIENCE[list.audience])) })).filter(
        (category) => category.lists.length > 0,
    )
}
