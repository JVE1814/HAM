import { andEachClause } from './encoded-query.ts'

/**
 * Asset lifecycle stages and the moves allowed between them.
 *
 * A Lifecycle stage is stored on the platform as an `install_status` + `substatus` pair (ADR 0002).
 * This module owns that mapping and the allowed-moves matrix; nothing else in the app should compare
 * raw install status or substatus values.
 */

export interface StageFields {
    installStatus: string
    substatus: string | null
}

/** Platform install_status values (alm_asset.install_status). */
export const INSTALL_STATUS = {
    inUse: '1',
    onOrder: '2',
    inMaintenance: '3',
    inStock: '6',
    retired: '7',
    missing: '8',
    inTransit: '9',
} as const

const STAGE_FIELDS = {
    on_order: { installStatus: INSTALL_STATUS.onOrder, substatus: '' },
    in_transit: { installStatus: INSTALL_STATUS.inTransit, substatus: '' },
    available: { installStatus: INSTALL_STATUS.inStock, substatus: 'available' },
    reserved: { installStatus: INSTALL_STATUS.inStock, substatus: 'reserved' },
    spare_pool: { installStatus: INSTALL_STATUS.inStock, substatus: 'reserved_spare_pool' },
    staging: { installStatus: INSTALL_STATUS.inStock, substatus: 'staging' },
    staged: { installStatus: INSTALL_STATUS.inStock, substatus: 'staged' },
    shipped: { installStatus: INSTALL_STATUS.inTransit, substatus: 'shipped_to_site' },
    pending_in_service: { installStatus: INSTALL_STATUS.inUse, substatus: 'pending_in_service' },
    in_service: { installStatus: INSTALL_STATUS.inUse, substatus: '' },
    temporary_deployment: { installStatus: INSTALL_STATUS.inUse, substatus: 'temporary_deployment' },
    pending_return: { installStatus: INSTALL_STATUS.inUse, substatus: 'pending_return' },
    pending_evaluation: { installStatus: INSTALL_STATUS.inStock, substatus: 'pending_evaluation' },
    pending_oem_rma: { installStatus: INSTALL_STATUS.inMaintenance, substatus: 'pending_oem_rma' },
    pending_wipe: { installStatus: INSTALL_STATUS.inStock, substatus: 'pending_wipe' },
    pending_disposal: { installStatus: INSTALL_STATUS.inStock, substatus: 'pending_disposal' },
    missing: { installStatus: INSTALL_STATUS.missing, substatus: 'lost' },
    disposed: { installStatus: INSTALL_STATUS.retired, substatus: 'disposed' },
    sold: { installStatus: INSTALL_STATUS.retired, substatus: 'sold' },
    returned_to_oem: { installStatus: INSTALL_STATUS.retired, substatus: 'vendor_credit' },
    returned_to_customer: { installStatus: INSTALL_STATUS.retired, substatus: 'returned_to_customer' },
    returned_to_lessor: { installStatus: INSTALL_STATUS.retired, substatus: 'lease_return' },
} as const satisfies Record<string, StageFields>

export type Stage = keyof typeof STAGE_FIELDS

export const ALL_STAGES = Object.keys(STAGE_FIELDS) as Stage[]

/**
 * Substatus values this app adds to the platform, with the install_status they depend on.
 * Shipped as sys_choice records (see ADR 0002); out-of-box values are not listed. Brazil ships
 * pending_evaluation under In stock and lease_return under Retired, so those stages use them.
 */
export const ADDED_SUBSTATUSES: ReadonlyArray<{ value: string; label: string; installStatus: string }> = [
    { value: 'reserved_spare_pool', label: 'Reserved - spare pool', installStatus: INSTALL_STATUS.inStock },
    { value: 'staging', label: 'Staging', installStatus: INSTALL_STATUS.inStock },
    { value: 'staged', label: 'Staged', installStatus: INSTALL_STATUS.inStock },
    { value: 'shipped_to_site', label: 'Shipped to site', installStatus: INSTALL_STATUS.inTransit },
    { value: 'pending_in_service', label: 'Pending in service', installStatus: INSTALL_STATUS.inUse },
    { value: 'temporary_deployment', label: 'Temporary deployment', installStatus: INSTALL_STATUS.inUse },
    { value: 'pending_return', label: 'Pending return', installStatus: INSTALL_STATUS.inUse },
    { value: 'pending_oem_rma', label: 'Pending OEM RMA', installStatus: INSTALL_STATUS.inMaintenance },
    { value: 'pending_wipe', label: 'Pending wipe', installStatus: INSTALL_STATUS.inStock },
    { value: 'returned_to_customer', label: 'Returned to customer', installStatus: INSTALL_STATUS.retired },
]

const RETIRED: ReadonlySet<Stage> = new Set([
    'disposed',
    'sold',
    'returned_to_oem',
    'returned_to_customer',
    'returned_to_lessor',
])

const AT_OR_TOWARDS_SITE: ReadonlySet<Stage> = new Set([
    'shipped',
    'pending_in_service',
    'in_service',
    'temporary_deployment',
    'pending_return',
])

const NEEDS_SITE_AND_AGREEMENT: ReadonlySet<Stage> = new Set([
    'shipped',
    'pending_in_service',
    'in_service',
    'temporary_deployment',
])

const ALLOWED_MOVES: Record<Stage, readonly Stage[]> = {
    on_order: ['in_transit', 'available'],
    in_transit: ['available'],
    available: ['reserved', 'spare_pool', 'staging', 'pending_evaluation', 'pending_wipe', 'missing'],
    spare_pool: ['reserved', 'available', 'staging', 'shipped', 'pending_in_service', 'missing'],
    reserved: ['staging', 'available', 'spare_pool', 'missing'],
    staging: ['staged', 'pending_evaluation', 'available'],
    staged: ['shipped', 'available', 'spare_pool'],
    shipped: ['pending_in_service', 'pending_return', 'missing'],
    pending_in_service: ['in_service', 'temporary_deployment', 'pending_return'],
    in_service: ['pending_return', 'missing'],
    temporary_deployment: ['pending_return', 'missing'],
    pending_return: ['pending_evaluation', 'missing'],
    missing: ['pending_evaluation', 'in_service'],
    pending_evaluation: ['available', 'spare_pool', 'pending_oem_rma', 'pending_wipe'],
    pending_oem_rma: ['pending_evaluation', 'returned_to_oem'],
    pending_wipe: ['pending_disposal', 'available'],
    pending_disposal: ['disposed', 'sold', 'returned_to_oem', 'returned_to_customer', 'returned_to_lessor'],
    disposed: [],
    sold: [],
    returned_to_oem: [],
    returned_to_customer: [],
    returned_to_lessor: [],
}

export type LegalOwner = 'provider' | 'customer' | 'lessor' | ''

export interface TransitionFacts {
    hasSite: boolean
    hasAgreement: boolean
    legalOwner: LegalOwner
    wipeEvidenceComplete: boolean
}

export type TransitionVerdict = { allowed: true } | { allowed: false; reason: string }

export function stageOf(fields: StageFields): Stage | null {
    const substatus = fields.substatus ?? ''
    for (const stage of ALL_STAGES) {
        const candidate = STAGE_FIELDS[stage]
        if (candidate.installStatus === fields.installStatus && candidate.substatus === substatus) {
            return stage
        }
    }
    return null
}

export function fieldsOf(stage: Stage): StageFields {
    return { ...STAGE_FIELDS[stage] }
}

export function isRetired(stage: Stage | null): boolean {
    return stage !== null && RETIRED.has(stage)
}

/** Assets that count against an Agreement's contracted quantities: at a Site or on the way there. */
export function isDeployed(stage: Stage | null): boolean {
    return stage !== null && AT_OR_TOWARDS_SITE.has(stage)
}

export function checkTransition(from: Stage | null, to: Stage, facts: TransitionFacts): TransitionVerdict {
    if (from === to) return { allowed: true }
    if (from === null) {
        return { allowed: false, reason: 'The asset is in a stage this app does not model; an administrator must correct it' }
    }
    if (!ALLOWED_MOVES[from].includes(to)) {
        return { allowed: false, reason: `Cannot move an asset from ${from} to ${to}` }
    }
    if (NEEDS_SITE_AND_AGREEMENT.has(to)) {
        if (!facts.hasSite) return { allowed: false, reason: `An asset must have a site before it can be ${to}` }
        if (!facts.hasAgreement) {
            return { allowed: false, reason: `An asset must belong to an agreement before it can be ${to}` }
        }
    }
    if (RETIRED.has(to)) return checkRetirement(from, to, facts)
    return { allowed: true }
}

/** The legal owner decides how an Asset may leave; a Lessor's reaches the OEM only on an OEM RMA, not as a takeback. */
function checkRetirement(from: Stage, to: Stage, facts: TransitionFacts): TransitionVerdict {
    const exitFor: Record<Exclude<LegalOwner, ''>, readonly Stage[]> = {
        provider: ['disposed', 'sold', 'returned_to_oem'],
        customer: ['returned_to_customer'],
        lessor: ['returned_to_lessor', 'returned_to_oem'],
    }
    const owner = facts.legalOwner || 'provider'
    if (!exitFor[owner].includes(to)) {
        return { allowed: false, reason: `A ${owner}-owned asset cannot leave as ${to}` }
    }
    if (owner === 'lessor' && to === 'returned_to_oem' && from !== 'pending_oem_rma') {
        return { allowed: false, reason: 'A lessor-owned asset goes to the OEM only under an OEM RMA' }
    }
    if (!facts.wipeEvidenceComplete) {
        return { allowed: false, reason: 'Record wipe evidence before the asset leaves the provider' }
    }
    return { allowed: true }
}

/**
 * Whether a move voids the Asset's wipe evidence: entering staging loads a Customer's configuration, which a wipe
 * recorded before does not cover. (Receipt from a Site voids it too, in entry/returns.)
 */
export function voidsWipeEvidence(from: Stage | null, to: Stage): boolean {
    return to === 'staging' && from !== 'staging'
}

export const DEPLOYED_STAGES: readonly Stage[] = [...AT_OR_TOWARDS_SITE]

/** At or on the way to a customer Site and not coming back: what leases, coverage warnings and lifecycle refreshes count as serving. */
export const SERVING_STAGES: readonly Stage[] = ['shipped', 'pending_in_service', 'in_service', 'temporary_deployment']

/**
 * An encoded query matching assets in any of `stages` (and `base`, repeated per clause because
 * ^NQ starts a new top-level OR group). `via` dot-walks to the asset from another table (`asset.`).
 */
export function stagesQuery(stages: readonly Stage[], base = '', via = ''): string {
    const clauses = stages
        .map((stage) => {
            const { installStatus, substatus } = STAGE_FIELDS[stage]
            return `${via}install_status=${installStatus}^${via}${substatus ? `substatus=${substatus}` : 'substatusISEMPTY'}`
        })
        .join('^NQ')
    return base ? andEachClause(clauses, base) : clauses
}

/** Stages in which an Asset delivers its Subscription line and is billed (D52). */
const BILLABLE: ReadonlySet<Stage> = new Set(['in_service', 'temporary_deployment'])

export function isBillable(stage: Stage | null): boolean {
    return stage !== null && BILLABLE.has(stage)
}

/** The dates a stage change can start or stop an Asset's billing on (YYYY-MM-DD). */
export interface BillingDates {
    /** The day the Asset went into service, once it has. */
    inServiceDate?: string
    today: string
}

/** Billing (the Asset's Service interval) starts or stops on this day (YYYY-MM-DD). */
export type BillingChange = { start: string } | { stop: string }

/**
 * Whether a stage change starts or stops an Asset's billing, and on which day: it starts from the
 * in-service date on first go-live (from pending in service), else today (e.g. found after being
 * missing), and stops today, whatever moved it (D52, ADR 0009).
 */
export function billingChange(before: Stage | null, after: Stage | null, dates: BillingDates): BillingChange | null {
    if (isBillable(before) === isBillable(after)) return null
    if (!isBillable(after)) return { stop: dates.today }
    return { start: (before === 'pending_in_service' && dates.inServiceDate) || dates.today }
}
