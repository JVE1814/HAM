import { PROPERTY } from './properties.ts'
import { PLATFORM_ROLE } from './roles.ts'
import { WEBHOOK_TOKEN_MIN_LENGTH, webhookTokenUsable } from './shipping.ts'

/** Install prerequisites that Fluent cannot declare as plugin dependencies (README "Required plugins"). */

const REQUIRED_TABLES: ReadonlyArray<{ table: string; provider: string }> = [
    { table: 'alm_hardware', provider: 'Asset Management' },
    { table: 'alm_transfer_order', provider: 'Asset Management' },
    { table: 'proc_po', provider: 'Procurement' },
    { table: 'customer_account', provider: 'Customer Service Management' },
    { table: 'sn_customerservice_case', provider: 'Customer Service Management' },
    { table: 'wm_order', provider: 'Field Service Management' },
    { table: 'change_request', provider: 'Change Management' },
    { table: 'cmdb_ci_rack', provider: 'CMDB' },
    { table: 'cmdb_hardware_model_lifecycle', provider: 'Model Management' },
    { table: 'sysapproval_approver', provider: 'Approvals' },
]

const REQUIRED_ROLES: readonly string[] = Object.values(PLATFORM_ROLE)

export const APP_SCOPE = 'x_daas_ham'

export interface PreflightReport {
    missing: string[]
    problems: string[]
    summary: string
}

/** A "Not available for" row of one of the app's catalog items: the item's name and the criterion's. */
export interface ItemExclusion {
    item: string
    criterion: string
}

export interface PreflightProbe {
    tableExists(table: string): boolean
    roleExists(role: string): boolean
    webhookToken(): string
    exclusions(): readonly ItemExclusion[]
}

export function preflightReport(probe: PreflightProbe): PreflightReport {
    const missing = [
        ...REQUIRED_TABLES.filter((t) => !probe.tableExists(t.table)).map((t) => `table ${t.table} (${t.provider})`),
        ...REQUIRED_ROLES.filter((r) => !probe.roleExists(r)).map((r) => `role ${r}`),
    ]
    const problems = [...webhookTokenProblems(probe.webhookToken()), ...probe.exclusions().map(exclusionProblem)]
    const counts = [
        ...(missing.length ? [`${missing.length} prerequisite(s) missing`] : []),
        ...(problems.length ? [`${problems.length} setting(s) to correct`] : []),
    ]
    return { missing, problems, summary: counts.length === 0 ? 'All prerequisites present' : counts.join(', ') }
}

/**
 * The app gives its record producers no "Not available for" row; the platform adds SNC External to each, which wins
 * over their "Available for" and keeps every Customer admin out. No install can remove it: an admin does (README "Install").
 */
function exclusionProblem({ item, criterion }: ItemExclusion): string {
    return `"${item}" is Not available for ${criterion}, which wins over its Available for: as admin, in global scope, remove that row (README "Install")`
}

/** An empty token is no problem: the webhook then refuses every call by design, as when the aggregator is off. */
function webhookTokenProblems(token: string): string[] {
    if (!token || webhookTokenUsable(token)) return []
    const name = PROPERTY.shippingWebhookToken.name
    return [`${name} is shorter than ${WEBHOOK_TOKEN_MIN_LENGTH} characters, so every tracking webhook is refused: set a longer one and register it with the aggregator`]
}
