/** Install prerequisites that Fluent cannot declare as plugin dependencies (README "Required plugins"). */

export const REQUIRED_TABLES: ReadonlyArray<{ table: string; provider: string }> = [
    { table: 'alm_hardware', provider: 'Asset Management' },
    { table: 'alm_transfer_order', provider: 'Asset Management' },
    { table: 'proc_po', provider: 'Procurement' },
    { table: 'customer_account', provider: 'Customer Service Management' },
    { table: 'sn_customerservice_case', provider: 'Customer Service Management' },
    { table: 'wm_order', provider: 'Field Service Management' },
    { table: 'change_request', provider: 'Change Management' },
    { table: 'cmdb_ci_rack', provider: 'CMDB' },
    { table: 'sysapproval_approver', provider: 'Approvals' },
]

export const REQUIRED_ROLES: readonly string[] = [
    'asset',
    'inventory_user',
    'inventory_admin',
    'procurement_user',
    'procurement_admin',
    'report_user',
    'snc_external',
    'canvas_user',
    'sn_customerservice_agent',
]

export interface PreflightReport {
    ok: boolean
    missing: string[]
    summary: string
}

export function preflightReport(probe: { tableExists(table: string): boolean; roleExists(role: string): boolean }): PreflightReport {
    const missing = [
        ...REQUIRED_TABLES.filter((t) => !probe.tableExists(t.table)).map((t) => `table ${t.table} (${t.provider})`),
        ...REQUIRED_ROLES.filter((r) => !probe.roleExists(r)).map((r) => `role ${r}`),
    ]
    return {
        ok: missing.length === 0,
        missing,
        summary: missing.length === 0 ? 'All prerequisites present' : `${missing.length} prerequisite(s) missing`,
    }
}
