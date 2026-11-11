import { andEachClause } from './encoded-query.ts'
import { INSTALL_STATUS, STAGE_FIELDS, type DisposalMethod, type LegalOwner } from './vocabulary.ts'

/**
 * Asset lifecycle stages and the moves allowed between them.
 *
 * A Lifecycle stage is stored on the platform as an `install_status` + `substatus` pair (ADR 0002, the pairs in
 * domain/vocabulary `STAGE_FIELDS`); In transfer is stored as either of two, both Inventory's. This module owns reading
 * and writing that mapping and the allowed-moves matrix; nothing else in the app should compare raw install status or
 * substatus values.
 */

export interface StageFields {
    installStatus: string
    substatus: string | null
}

export type Stage = keyof typeof STAGE_FIELDS

export const ALL_STAGES = Object.keys(STAGE_FIELDS) as Stage[]

/**
 * The other platform combinations a stage is stored as. Inventory's *Push Status to Asset/Consumable* rule sets an
 * Asset on a transfer order line to In stock / Pending transfer (Draft, Requested, Shipment Preparation) and to In
 * transit / Reserved (In Transit), both one stage here: In transfer (external-contracts N38).
 */
const ALSO_STORED_AS: Partial<Record<Stage, readonly StageFields[]>> = {
    in_transfer: [{ installStatus: INSTALL_STATUS.inTransit, substatus: 'reserved' }],
}

function storedAs(stage: Stage): readonly StageFields[] {
    return [STAGE_FIELDS[stage], ...(ALSO_STORED_AS[stage] ?? [])]
}

const RETIRED: ReadonlySet<Stage> = new Set([
    'disposed',
    'sold',
    'returned_to_oem',
    'returned_to_customer',
    'returned_to_lessor',
])

/** In use at a Site: an Asset in one of these delivers its Subscription line and is billed (Q52), and monitoring should see it. */
export const IN_USE_STAGES: readonly Stage[] = ['in_service', 'temporary_deployment']

/** Installed at a Site: in use, or awaiting first sighting (temporary ends, audits, attestations). */
export const INSTALLED_STAGES: readonly Stage[] = [...IN_USE_STAGES, 'pending_in_service']

/**
 * At or on the way to a customer Site and not coming back: what leases, coverage warnings and lifecycle refreshes count
 * as serving. An Asset needs its Site and its Agreement to be in one.
 */
export const SERVING_STAGES: readonly Stage[] = ['shipped', 'pending_in_service', 'in_service', 'temporary_deployment']

/** At a Site or on the way there, coming back included: what counts against an Agreement's contracted quantities. */
export const DEPLOYED_STAGES: readonly Stage[] = [...SERVING_STAGES, 'pending_return']

/** Stock on no Order line: free stock and a Customer's Spare pool, which sourcing reserves from. */
export const STOCK_STAGES: readonly Stage[] = ['available', 'spare_pool']

/** Stock a transfer order moves between stockrooms, and the stages it takes back once Inventory lets it go. */
const TRANSFERABLE: readonly Stage[] = ['available', 'reserved', 'spare_pool', 'staging']

const ALLOWED_MOVES: Record<Stage, readonly Stage[]> = {
    on_order: ['in_transit', 'available'],
    in_transit: ['available'],
    available: ['reserved', 'spare_pool', 'staging', 'pending_evaluation', 'pending_wipe', 'missing', 'in_transfer'],
    spare_pool: ['reserved', 'available', 'staging', 'shipped', 'pending_in_service', 'missing', 'in_transfer'],
    reserved: ['staging', 'available', 'spare_pool', 'missing', 'in_transfer'],
    staging: ['staged', 'pending_evaluation', 'available', 'in_transfer'],
    staged: ['shipped', 'available', 'spare_pool'],
    in_transfer: TRANSFERABLE,
    shipped: ['pending_in_service', 'pending_return', 'missing'],
    // Missing: an installed unit never seen, on a return that is overdue (platform/returns `chaseOverdue`), like one in service.
    pending_in_service: ['in_service', 'temporary_deployment', 'pending_return', 'missing'],
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

export interface TransitionFacts {
    hasSite: boolean
    hasAgreement: boolean
    /** As stored: blank counts as the Provider's. */
    legalOwner: LegalOwner | ''
    wipeEvidenceComplete: boolean
    /**
     * Inventory has the Asset on an open transfer order line once the save is made (its *Active transfer order* flag,
     * which Inventory sets and clears in the same save as the stage). Only then may an Asset go into transfer, and
     * only once Inventory lets it go may it leave: a unit on its way between two stockrooms is nobody's stock. Left
     * out, it counts as not on a line, so the app's own moves never put an Asset into transfer; none of them takes one
     * out either (Cancel order takes a unit in transfer off its Order line and leaves it in transfer, platform/orders).
     */
    onTransferOrderLine?: boolean
}

export type TransitionVerdict = { allowed: true } | { allowed: false; reason: string }

export function stageOf(fields: StageFields): Stage | null {
    const substatus = fields.substatus ?? ''
    const matches = (candidate: StageFields) => candidate.installStatus === fields.installStatus && candidate.substatus === substatus
    return ALL_STAGES.find((stage) => storedAs(stage).some(matches)) ?? null
}

/** The combination the app stores `stage` as (In transfer: In stock / Pending transfer, which the app never sets). */
export function fieldsOf(stage: Stage): StageFields {
    const { installStatus, substatus } = STAGE_FIELDS[stage]
    return { installStatus, substatus }
}

export function isRetired(stage: Stage | null): boolean {
    return stage !== null && RETIRED.has(stage)
}

export function isDeployed(stage: Stage | null): boolean {
    return stage !== null && DEPLOYED_STAGES.includes(stage)
}

export function checkTransition(from: Stage | null, to: Stage, facts: TransitionFacts): TransitionVerdict {
    if (from === to) return { allowed: true }
    if (from === null) {
        return { allowed: false, reason: 'The asset is in a stage this app does not model; an administrator must correct it' }
    }
    if (!ALLOWED_MOVES[from].includes(to)) {
        return { allowed: false, reason: `Cannot move an asset from ${from} to ${to}` }
    }
    if (to === 'in_transfer' && !facts.onTransferOrderLine) {
        return { allowed: false, reason: 'An asset is in transfer only while it is on an open transfer order line' }
    }
    if (from === 'in_transfer' && facts.onTransferOrderLine) {
        return { allowed: false, reason: 'An asset leaves transfer only once Inventory lets it go from its transfer order line' }
    }
    if (SERVING_STAGES.includes(to)) {
        if (!facts.hasSite) return { allowed: false, reason: `An asset must have a site before it can be ${to}` }
        if (!facts.hasAgreement) {
            return { allowed: false, reason: `An asset must belong to an agreement before it can be ${to}` }
        }
    }
    if (RETIRED.has(to)) return checkRetirement(from, to, facts)
    return { allowed: true }
}

/**
 * The moves, one save each, by which an Asset gets from `from` to `to` in the fewest the matrix allows: the lifecycle
 * rule checks every save as one move, so a unit going further walks the stages between (a Spare pool unit to pending
 * wipe through available, a pending-wipe one to a retired stage through pending disposal). It passes only through
 * stages In stock, where a move books the unit and nothing happens to it: an installed unit is never returned on the
 * way. Empty when it is there already. With no path there it is `to` alone, so the move is refused with
 * `checkTransition`'s reason.
 */
export function pathTo(from: Stage | null, to: Stage): readonly Stage[] {
    if (from === to) return []
    if (from === null) return [to]
    const seen = new Set<Stage>([from])
    let paths: Stage[][] = [[]]
    while (paths.length > 0) {
        const longer: Stage[][] = []
        for (const path of paths) {
            for (const next of ALLOWED_MOVES[path.length > 0 ? path[path.length - 1] : from]) {
                if (next === to) return [...path, to]
                if (seen.has(next) || STAGE_FIELDS[next].installStatus !== INSTALL_STATUS.inStock) continue
                seen.add(next)
                longer.push([...path, next])
            }
        }
        paths = longer
    }
    return [to]
}

/**
 * Why a save that sets an Asset's stage by hand (from `from` to `to`, null for a combination the app does not model)
 * breaks the lifecycle, or null when it follows it: a save into or out of a combination the app does not model is
 * refused.
 */
export function stageChangeRefusal(from: Stage | null, to: Stage | null, facts: TransitionFacts): string | null {
    if (to === null) return 'This install status / substatus combination is not used by NaaS asset management'
    const verdict = checkTransition(from, to, facts)
    return verdict.allowed ? null : verdict.reason
}

/** Whose an Asset is, from its Legal owner as stored: a blank one is the Provider's (the column has no default). */
export function legalOwnerOf(stored: LegalOwner | ''): LegalOwner {
    return stored || 'provider'
}

/**
 * How an Asset may leave the Provider (P2.5, Q61): each Disposal method, whose Assets it retires and the stage it
 * leaves them in. The one way out that is no Disposal method is an OEM RMA (`checkRetirement`).
 */
const EXIT: Record<DisposalMethod, { owner: LegalOwner; stage: Stage }> = {
    broker_resale: { owner: 'provider', stage: 'sold' },
    oem_takeback: { owner: 'provider', stage: 'returned_to_oem' },
    itad_recycle: { owner: 'provider', stage: 'disposed' },
    return_to_customer: { owner: 'customer', stage: 'returned_to_customer' },
    return_to_lessor: { owner: 'lessor', stage: 'returned_to_lessor' },
}

export function disposalStage(method: DisposalMethod): Stage {
    return EXIT[method].stage
}

export function disposalMethodsFor(owner: LegalOwner): DisposalMethod[] {
    return (Object.keys(EXIT) as DisposalMethod[]).filter((method) => EXIT[method].owner === owner)
}

/** The legal owner decides how an Asset may leave; a Lessor's reaches the OEM only on an OEM RMA, not as a takeback. */
function checkRetirement(from: Stage, to: Stage, facts: TransitionFacts): TransitionVerdict {
    const owner = legalOwnerOf(facts.legalOwner)
    const toOemForLessor = owner === 'lessor' && to === 'returned_to_oem'
    if (!toOemForLessor && !disposalMethodsFor(owner).some((method) => disposalStage(method) === to)) {
        return { allowed: false, reason: `A ${owner}-owned asset cannot leave as ${to}` }
    }
    if (toOemForLessor && from !== 'pending_oem_rma') {
        return { allowed: false, reason: 'A lessor-owned asset goes to the OEM only under an OEM RMA' }
    }
    if (!facts.wipeEvidenceComplete) {
        return { allowed: false, reason: 'Record wipe evidence before the asset leaves the provider' }
    }
    return { allowed: true }
}

/**
 * What an Asset Inventory lets go from its transfer order line still carries, and where Inventory left it: what tells
 * the stage it left, and whether the transfer sourcing raised for it fell through.
 */
export interface TransferContext {
    /** It is on an Order line: only sourcing transfers such a unit, to the staging centre. */
    onOrderLine: boolean
    /** A Staging task is open for it: sourcing opens one for each unit it transfers to the staging centre. */
    stagingTaskOpen: boolean
    /** Its company is a Customer, not the Provider: on no Order line, that Customer's Spare pool. */
    heldForCustomer: boolean
    /**
     * Inventory left it in the staging centre's stockroom: there once its line is received, and still where it was
     * sent from when its line is cancelled or deleted.
     */
    atStagingCentre: boolean
    /** Sourcing is removing the transfer order it could not complete, and puts the unit back itself. */
    withdrawnBySourcing: boolean
}

/**
 * The stage an Asset takes back once Inventory lets it go from its transfer order line (received, cancelled or
 * deleted), instead of the platform's In stock / Available: the one it left, as its context still shows. On an Order
 * line it was reserved for it, and goes into staging once it is at the staging centre with its Staging task waiting
 * (a unit sourcing transfers there is staged on arrival); anywhere else it is reserved again, its transfer fallen
 * through (`transferFellThrough`). In a Customer's Spare pool it goes back to the pool; else it is free stock. Each is
 * a move out of transfer the matrix allows.
 */
export function stageAfterTransfer(context: TransferContext): Stage {
    if (context.onOrderLine) return context.stagingTaskOpen && context.atStagingCentre ? 'staging' : 'reserved'
    return context.heldForCustomer ? 'spare_pool' : 'available'
}

/**
 * Whether the transfer sourcing raised for a unit on an Order line fell through: Inventory let it go short of the
 * staging centre (its line cancelled or deleted), reserved where nothing moves it on. It is put back as stock and its
 * Order sourced again (platform/sourcing `putBackUntransferred`), unless sourcing is removing that transfer order itself.
 */
export function transferFellThrough(context: TransferContext): boolean {
    return context.onOrderLine && !context.atStagingCentre && !context.withdrawnBySourcing
}

/**
 * Whether a move voids the Asset's wipe evidence: entering staging loads a Customer's configuration, which a wipe
 * recorded before does not cover. (Receipt from a Site voids it too, in platform/returns.)
 */
export function voidsWipeEvidence(from: Stage | null, to: Stage): boolean {
    return to === 'staging' && from !== 'staging'
}

/**
 * An encoded query matching assets in any of `stages` (and `base`, repeated per clause because
 * ^NQ starts a new top-level OR group), one clause per combination a stage is stored as. `via`
 * dot-walks to the asset from another table (`asset.`).
 */
export function stagesQuery(stages: readonly Stage[], base = '', via = ''): string {
    const clauses = stages
        .flatMap(storedAs)
        .map(({ installStatus, substatus }) => {
            return `${via}install_status=${installStatus}^${via}${substatus ? `substatus=${substatus}` : 'substatusISEMPTY'}`
        })
        .join('^NQ')
    return base ? andEachClause(clauses, base) : clauses
}

export function notRetiredCondition(): string {
    return `install_status!=${INSTALL_STATUS.retired}`
}

export function isBillable(stage: Stage | null): boolean {
    return stage !== null && IN_USE_STAGES.includes(stage)
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
 * missing), and stops today, whatever moved it (Q52, ADR 0009).
 */
export function billingChange(before: Stage | null, after: Stage | null, dates: BillingDates): BillingChange | null {
    if (isBillable(before) === isBillable(after)) return null
    if (!isBillable(after)) return { stop: dates.today }
    return { start: (before === 'pending_in_service' && dates.inServiceDate) || dates.today }
}
