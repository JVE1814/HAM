/**
 * What the platform's ACLs let provider staff, and on ast_contract Customer admins, do on the platform tables the
 * workspace reaches, as recorded on a dev instance in November 2026 (docs/research/external-contracts.md N50). The app
 * ships none of these ACLs, so the build cannot tell; `built-metadata.test.ts` judges a workspace list or widget by
 * these facts and the app's own built ACLs together, and fails on a platform table it reaches that has no entry here.
 * It also holds each field ACL the app puts on a child of ast_contract to every reader the field had through it.
 *
 * A role list is the roles of the ACLs of one name and operation, ORed. Where an ACL's script narrows its roles, the
 * list holds the roles that were seen to pass it. `public` passes everyone, `snc_internal` every user who holds no
 * `snc_external`, so every provider-staff user and no Customer contact. An entry that omits `read`, or a field, records
 * no ACL there: every provider-staff role was seen to read it through every workspace list, or the app's own ACLs decide.
 */

export const PUBLIC = 'public'
export const SIGNED_IN = 'snc_internal'
export const EXTERNAL = 'snc_external'

export interface PlatformTable {
    /** The platform table it extends, whose ACLs and columns it inherits. */
    extends?: string
    /** The field a reference to it shows, which the workspace searches it by (ui/meta `reference_display_field`). */
    display?: string
    /** Roles of its record read ACLs. */
    read?: readonly string[]
    /** Field read ACLs by field, `*` for every field with none of its own. */
    fieldRead?: Readonly<Record<string, readonly string[]>>
    /** Field query_range ACLs (what a LIKE search needs) by field. */
    fieldQueryRange?: Readonly<Record<string, readonly string[]>>
    /** Its reference columns the workspace reaches, with the table each points at. */
    references?: Readonly<Record<string, string>>
}

const CONTRACT_MANAGER = 'contract_manager'
const SERVICE_DESK = 'sn_customerservice_agent'

/*
 * ast_contract's number, short description, state, starts and ends each have a CRM Base Entities read ACL for
 * snc_internal, sn_esm_user and sn_customerservice.requester whose script admits contract_manager, sn_esm_user,
 * sn_esm_agent and sn_customerservice.requester, and on all but number sn_customerservice.customer_data_viewer (its
 * Subscription contract model admits no Agreement, as none has one). So a Customer admin passes it through sn_esm_user,
 * and the service desk through sn_esm_agent. Each field's other ACL, Service Management Core's for snc_internal, admits
 * contract_manager and a role the NOC, account managers and finance were seen not to hold.
 */
const CONTRACT_FIELD_READERS = [CONTRACT_MANAGER, 'sn_esm_user', 'sn_esm_agent', 'sn_customerservice.requester']
const CONTRACT_DETAIL_READERS = [...CONTRACT_FIELD_READERS, 'sn_customerservice.customer_data_viewer']

export const PLATFORM_TABLES: Readonly<Record<string, PlatformTable>> = {
    customer_account: {
        extends: 'core_company',
        display: 'name',
        read: [
            'csm_ws_integration',
            'sn_crm_account_viewer',
            'sn_customerservice.customer_data_viewer',
            SERVICE_DESK,
            'sn_customerservice.contact_manager',
            'sn_customerservice.cust_data_resp_granular',
            'sn_customerservice.customer',
        ],
        fieldRead: {
            '*': ['sn_crm_account_viewer', 'csm_ws_integration', 'sn_customerservice.customer_data_viewer', 'sn_esm_agent'],
            name: [
                'sn_customerservice.customer_data_viewer',
                'sn_customerservice.contact_manager',
                'sn_customerservice.customer',
                'sn_esm_agent',
                'sn_crm_account_viewer',
                'csm_ws_integration',
            ],
            phone: ['sn_customerservice.customer_data_viewer', 'csm_ws_integration', 'sn_customerservice.customer', 'sn_esm_agent', 'sn_crm_account_viewer'],
        },
        fieldQueryRange: { '*': [PUBLIC], primary_contact: [PUBLIC] },
    },
    core_company: {
        display: 'name',
        read: [
            'ai_user_admin',
            'sn_gf.goal_user_read',
            'wm_agent',
            'wm_initiator',
            'nds_admin',
            'procurement_user',
            'service_viewer',
            'inventory_user',
            'model_manager',
            'problem_task_analyst',
            'itil',
            'user_admin',
            'user_criteria_admin',
            CONTRACT_MANAGER,
            'wm_qualifier',
            'sn_problem_read',
            'wm_admin',
            'wm_dispatcher',
        ],
        fieldQueryRange: { '*': [PUBLIC], vendor_manager: [PUBLIC], vendor_type: [PUBLIC] },
    },
    cmdb_ci: { read: ['cmdb_read', 'service_viewer'] },
    proc_po: { read: ['asset', 'procurement_user'] },
    sn_customerservice_case: {
        extends: 'task',
        display: 'number',
        read: [
            'sn_customerservice.customer',
            'sn_customerservice.case_task_agent',
            'sn_customerservice.case_viewer',
            'sn_customerservice_manager',
            SERVICE_DESK,
            'sn_customerservice.consumer_agent',
            'sn_customerservice.requester',
            'sn_esm_user',
            'sn_esm_agent',
            'csm_ws_integration',
            'sn_customerservice.case_mgmt_resp_granular',
            'sn_customerservice.case_read_granular',
            'sn_customerservice.all_cases_viewer',
            'sn_customerservice.consumer',
            'sn_customerservice.unified_consumer',
            'sn_customerservice.all_case_tasks_reader',
            'sn_customerservice.case_tasks_reader',
            'sn_customerservice.case_task_viewer',
        ],
    },
    cmn_location: { display: 'name', read: [SIGNED_IN] },
    sys_user: { display: 'name', read: [SIGNED_IN] },
    ast_contract: {
        display: 'vendor_contract',
        read: ['procurement_user', CONTRACT_MANAGER],
        fieldRead: {
            '*': [CONTRACT_MANAGER],
            number: CONTRACT_FIELD_READERS,
            short_description: CONTRACT_DETAIL_READERS,
            state: CONTRACT_DETAIL_READERS,
            starts: CONTRACT_DETAIL_READERS,
            ends: CONTRACT_DETAIL_READERS,
            vendor: [CONTRACT_MANAGER],
            vendor_contract: [CONTRACT_MANAGER],
            description: [CONTRACT_MANAGER],
            substate: [CONTRACT_MANAGER],
            contract_model: [CONTRACT_MANAGER],
            approver: [CONTRACT_MANAGER],
            contract_administrator: [CONTRACT_MANAGER],
            contract_composite: [CONTRACT_MANAGER],
            vendor_account: [CONTRACT_MANAGER],
            account: [SERVICE_DESK, 'sn_customerservice.customer_data_viewer', 'sn_esm_user', 'sn_customerservice.requester'],
            consumer: ['sn_customerservice.consumer_agent', 'sn_customerservice.requester', 'sn_esm_user', 'sn_customerservice_manager', 'sn_customerservice.customer_data_viewer'],
        },
        fieldQueryRange: {
            '*': [CONTRACT_MANAGER],
            starts: [CONTRACT_MANAGER],
            vendor: [CONTRACT_MANAGER],
            vendor_contract: [CONTRACT_MANAGER],
            po_number: [CONTRACT_MANAGER],
            approver: [PUBLIC],
            business_owner: [PUBLIC],
            contract_composite: [PUBLIC],
            process_non_contractual_slas: [PUBLIC],
        },
        references: { customer: 'core_company', vendor: 'core_company' },
    },
    task: { display: 'number' },
    alm_asset: {},
    alm_hardware: {
        extends: 'alm_asset',
        display: 'display_name',
        references: { company: 'core_company', model: 'cmdb_model', stockroom: 'alm_stockroom' },
    },
    alm_stockroom: { read: [SIGNED_IN] },
    cmdb_model: { read: [SIGNED_IN], references: { manufacturer: 'core_company' } },
    cmdb_model_lifecycle: { read: [SIGNED_IN], references: { model: 'cmdb_model' } },
}

/**
 * The fields with a public query_range ACL named `*.<field>`, which decides a search on such a field of any table that
 * has no query_range ACL for the field itself. The `*.*` ones (a Deny-Unless every user passes, and an allow for
 * platform_ml_read) refuse no provider staff.
 */
export const PUBLIC_QUERY_RANGE_FIELDS: ReadonlySet<string> = new Set(
    `
    account account_name account_number active additional_assignee_list additional_info agent application approval
    asset asset_tag assigned_to assignment_group business_duration business_service caller case cat_item category
    change_control checked_in checked_out ci ci_sys_id city close_notes closed_at closed_by cmdb_ci code comments
    company condition configuration_item consumer consumer_profile contact contact_type contract
    correlation_display correlation_id cost_center country customer department description discovery_source
    display_name display_value dns_domain due due_date duration element email email_address end end_date end_time
    ends entity first_name fqdn full_name group group_list host_name id incident install_date install_status
    invoice_number ip_address item justification key label location mac_address mailbox managed_by managed_by_group
    manufacturer message mobile_phone model model_category model_id model_number name node notes number object_id
    opened_by operational_status order os owned_by owner parent path percent_complete phone planned_end_date
    planned_start_date po_number priority product project project_name purchase_order reassignment_count
    request_item request_type requested_by requested_date requested_for role script serial_number service_offering
    short_description skills sla source stage start start_date start_time starts state status stockroom street
    subcategory subject supplier support_group sys_class_name sys_created_by sys_created_on sys_domain
    sys_domain_path sys_id sys_mod_count sys_scope sys_updated_on table table_name task task_effective_number title
    to type u_application_id u_data u_description u_end_date u_id u_name u_user_name urgency url user user_name
    valid_to value variables vendor version watch_list work_notes work_notes_list zip
`
        .trim()
        .split(/\s+/),
)

/** The roles a platform role contains. */
export const PLATFORM_ROLE_CONTAINS: Readonly<Record<string, readonly string[]>> = {
    asset: [CONTRACT_MANAGER, 'cmdb_read', 'procurement_user', 'inventory_user', 'model_manager'],
    procurement_user: ['canvas_user', 'model_manager', 'sn_itam_recomm.recommendations_read', 'financial_mgmt_user'],
    contract_manager: ['financial_mgmt_user', 'sn_itam_recomm.recommendations_read', 'canvas_user'],
    service_viewer: ['cmdb_read', 'pa_viewer'],
    [SERVICE_DESK]: [
        'sn_esm_agent',
        'sn_templated_snip.template_snippet_reader',
        'actsub_user',
        'sn_shn.editor',
        'knowledge',
        'chat_admin',
        'template_editor',
    ],
    'sn_customerservice.customer': ['sn_esm_user', EXTERNAL],
    sn_esm_user: [EXTERNAL],
}

/**
 * The platform roles the holders of an app role hold beside it, which the app does not grant: the Customer admin seen
 * is a Customer Service contact with sn_customerservice.customer.
 */
export const HELD_WITH: Readonly<Record<string, readonly string[]>> = {
    'x_daas_ham.customer_admin': ['sn_customerservice.customer'],
}
