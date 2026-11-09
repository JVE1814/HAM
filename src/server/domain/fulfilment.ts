import type { ApprovalDecision } from './approvals.ts'
import type { Approver } from './entitlement.ts'
import { assertNever, oneOf } from './exhaustive.ts'
import type { Stage } from './lifecycle.ts'

/**
 * Order-line and Order stages are derived, never set by hand: a line follows the slowest of its
 * Assets, an Order follows the slowest of its live lines.
 */

export type LineStage =
    | 'new'
    | 'awaiting_stock'
    | 'sourced'
    | 'staging'
    | 'ready_to_ship'
    | 'shipped'
    | 'installed'
    | 'in_service'
    | 'cancelled'

export type OrderStage = 'sourcing' | 'preparing' | 'delivering' | 'installing' | 'complete' | 'cancelled'

/**
 * How far an allocated Asset has progressed along fulfilment (higher is further). A unit in transfer is on its way to
 * the staging centre, sourced like one reserved where it is.
 */
const PROGRESS: Partial<Record<Stage, number>> = {
    reserved: 1,
    in_transfer: 1,
    staging: 2,
    staged: 3,
    spare_pool: 3,
    shipped: 4,
    pending_in_service: 5,
    in_service: 6,
    temporary_deployment: 6,
}

const LINE_FOR_PROGRESS: Record<number, LineStage> = {
    1: 'sourced',
    2: 'staging',
    3: 'ready_to_ship',
    4: 'shipped',
    5: 'installed',
    6: 'in_service',
}

/** A line's stages in the order a line goes through them; cancelled is none of them. */
const LINE_ORDER = ['new', 'awaiting_stock', 'sourced', 'staging', 'ready_to_ship', 'shipped', 'installed', 'in_service'] as const satisfies readonly LineStage[]

type LiveLineStage = (typeof LINE_ORDER)[number]

/** Every line stage, to read x_daas_ham_order_line.line_stage with (platform/records `choice`). */
export const LINE_STAGES: readonly LineStage[] = [...LINE_ORDER, 'cancelled']

/** How far along LINE_ORDER a line stage is; -1 for cancelled or a stage the app does not know. */
function rank(stage: LineStage): number {
    return (LINE_ORDER as readonly LineStage[]).indexOf(stage)
}

/** Line stages at which the line's equipment has left the Provider. */
const DELIVERED: ReadonlySet<LineStage> = new Set(['shipped', 'installed', 'in_service'])

/**
 * Stages a unit on a line can hold before Ship sends it. Missing and available are among them, as a unit lost or put
 * back before Ship goes there too, and so is in transfer, between two of the Provider's stockrooms. Any other stage
 * means it was sent (a hot spare handed over at Ship included) and may have come back since: failed staging takes a
 * unit off its line, so one evaluated on its line came from the Site.
 */
const BEFORE_SHIP: ReadonlySet<Stage> = new Set([
    'on_order',
    'in_transit',
    'available',
    'reserved',
    'in_transfer',
    'spare_pool',
    'staging',
    'staged',
    'missing',
])

/** Whether a unit on a line in `stage` was sent to the Site (and may have come back since). */
function sent(stage: Stage | null): stage is Stage {
    return stage !== null && !BEFORE_SHIP.has(stage)
}

/** What a line's stage is derived from. */
export interface LineFacts {
    /** The stage the line is in now. */
    current: LineStage
    quantity: number
    assetStages: ReadonlyArray<Stage | null>
    /**
     * A unit that left the line in transit was just taken off it (`refillsLine`): the line is filled again, so it is
     * derived as a line not yet delivered, from shipped too.
     */
    refill?: boolean
}

/**
 * The stage a line at `current` takes from its Assets. Once delivered it only moves forward, following the Assets still
 * on their way into service: one that leaves after install (a return, a swap-back of a dead-on-arrival unit, declared
 * missing) neither sends the line back nor holds it up. A unit that leaves in transit is taken off the line instead,
 * which is then filled again (`refill`); one of its units that left after install still counts as delivered.
 */
export function lineStageFor(line: LineFacts): LineStage {
    if (line.current === 'cancelled' || line.quantity <= 0) return 'cancelled'
    const progress = line.assetStages.map((stage) => (stage ? PROGRESS[stage] : undefined)).filter((p): p is number => p !== undefined)
    if (line.refill || !DELIVERED.has(line.current)) {
        const delivered = line.assetStages.filter((stage) => sent(stage) && PROGRESS[stage] === undefined).length
        if (progress.length === 0 || progress.length + delivered < line.quantity) return 'awaiting_stock'
        return LINE_FOR_PROGRESS[Math.min(...progress)]
    }
    const derived = progress.length > 0 ? LINE_FOR_PROGRESS[Math.min(...progress)] : line.current
    return rank(derived) > rank(line.current) ? derived : line.current
}

/**
 * Whether a unit moving `from` -> `to` left its line in transit: shipped (a hot spare handed over at Ship included),
 * then lost or sent back before it was installed. One that leaves after install (pending in service or later) counts
 * as delivered.
 */
export function leftInTransit(from: Stage | null, to: Stage | null): boolean {
    return from === 'shipped' && (to === 'missing' || to === 'pending_return')
}

/** Line stages before install: a unit that leaves one in transit is still owed to it. */
const REFILLABLE: readonly LineStage[] = ['awaiting_stock', 'sourced', 'staging', 'ready_to_ship', 'shipped']

/**
 * Whether a unit that left its line in transit (`leftInTransit`) is taken off it and the line filled again: back to
 * awaiting stock and sourced again, with no new approval and its quantity unchanged. Not on a whole-Site recovery (site
 * decommission, agreement end), which brings everything back: filled again, the line would buy and send a unit to a
 * Site being emptied. Nor on a line installed, cancelled or new, which a unit still in transit never holds.
 */
export function refillsLine(line: { stage: LineStage; siteRecovery: boolean }): boolean {
    return !line.siteRecovery && REFILLABLE.includes(line.stage)
}

/** Return triggers that bring back all of a Site, units in transit too (domain/returns `SITE_RECOVERY_STAGES`). */
const SITE_RECOVERY_TRIGGERS = ['site_decommission', 'agreement_end']

/** Encoded query on x_daas_ham_return_order_line: the Asset is awaited back on a whole-Site recovery. */
export function siteRecoveryLineQuery(assetId: string): string {
    return `asset=${assetId}^status=awaiting^return_order.triggerIN${SITE_RECOVERY_TRIGGERS.join(',')}`
}

/** What Cancel order reads of an Order: the stages of its lines and of every Asset on them. */
export interface OrderShipment {
    lineStages: readonly LineStage[]
    unitStages: ReadonlyArray<Stage | null>
}

/**
 * Whether anything of the Order has shipped, so it is not cancelled but brought back with a Return order: a line
 * delivered, or any unit of its lines sent, also on a line not delivered whole (a partial Ship, a hot spare handed over
 * at Ship, a line filled again after a unit left it in transit). A unit taken off its line in transit no longer counts.
 */
export function anythingShipped(order: OrderShipment): boolean {
    return order.lineStages.some((stage) => DELIVERED.has(stage)) || order.unitStages.some(sent)
}

const APPROVER_NAMES: Record<Approver, string> = {
    customer_admin: 'a Customer admin',
    account_manager: 'the account manager (or the asset managers)',
}

/**
 * Why approvals that roll up to neither outcome (domain/approvals `rollupApprovals` gives requested) keep an Order
 * awaiting approval, as Re-check approvals tells the user: whose approval is missing, and whether a request to them is
 * still waiting.
 */
export function approvalAwaited(required: readonly Approver[], decisions: readonly ApprovalDecision[]): string {
    const approved = new Set(decisions.filter((d) => d.state === 'approved').map((d) => d.group))
    const missing = required.filter((group) => !approved.has(group))
    const who = missing.map((group) => APPROVER_NAMES[group]).join(' and ')
    const waiting = decisions.some((d) => d.state === 'requested' && missing.includes(d.group))
    return waiting ? `waiting for ${who} to decide` : `no approval from ${who} and none still requested`
}

/** Order stages its lines no longer move: before approval, and once rejected, cancelled or complete. */
const SETTLED_ORDER_STAGES: readonly string[] = ['draft', 'awaiting_approval', 'rejected', 'cancelled', 'complete']

/** Whether an Order's stage still follows its lines (a complete Order stays complete when its Assets leave service). */
export function followsLines(orderStage: string): boolean {
    return !SETTLED_ORDER_STAGES.includes(orderStage)
}

/**
 * The stage an Order takes from its lines: cancelled once every line is, else that of its slowest live line, complete
 * only once each is in service. A line stage the app does not know (a corrupt row, a choice an administrator added: the
 * stages are read from records) counts as slower than any, so it holds the Order at sourcing and never completes it.
 */
export function orderStageFor(lineStages: readonly LineStage[]): OrderStage {
    const live = lineStages.filter((s) => s !== 'cancelled')
    if (live.length === 0) return 'cancelled'
    const known = live.filter((stage): stage is LiveLineStage => oneOf(stage, LINE_ORDER) !== undefined)
    if (known.length < live.length) return 'sourcing'
    const slowest = known.reduce((a, b) => (rank(a) <= rank(b) ? a : b))
    switch (slowest) {
        case 'new':
            return 'sourcing'
        case 'awaiting_stock':
        case 'sourced':
        case 'staging':
            return 'preparing'
        case 'ready_to_ship':
            return 'delivering'
        case 'shipped':
        case 'installed':
            return 'installing'
        case 'in_service':
            return 'complete'
        default:
            return assertNever(slowest, 'line stage')
    }
}
