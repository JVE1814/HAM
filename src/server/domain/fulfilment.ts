import { assertNever, oneOf } from './exhaustive.ts'
import type { Stage } from './lifecycle.ts'
import { ORDER_STAGE, TASK_STATE, type LineStage, type OrderStage } from './vocabulary.ts'

/**
 * Order-line and Order stages are derived, never set by hand: a line follows the slowest of its
 * Assets, an Order follows the slowest of its live lines.
 */

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

/**
 * The stages a live Order line goes through, in order: every subset of them below is cut from this. Cancelled is none
 * of them.
 */
const LINE_ORDER = ['new', 'awaiting_stock', 'sourced', 'staging', 'ready_to_ship', 'shipped', 'installed', 'in_service'] as const satisfies readonly LineStage[]
const SHIPPED_AT = LINE_ORDER.indexOf('shipped')

type LiveLineStage = (typeof LINE_ORDER)[number]

/** Every line stage, to read x_daas_ham_order_line.line_stage with (platform/records `choice`). */
export const LINE_STAGES: readonly LineStage[] = [...LINE_ORDER, 'cancelled']

/** How far along LINE_ORDER a line stage is; -1 for cancelled or a stage the app does not know. */
function rank(stage: LineStage): number {
    return (LINE_ORDER as readonly LineStage[]).indexOf(stage)
}

/**
 * Order line stages before the line has shipped: such a line's whole quantity counts as in-flight usage, and it is
 * what cancelling or rejecting its Order cancels.
 */
export const OPEN_LINE_STAGES: readonly LineStage[] = LINE_ORDER.slice(0, SHIPPED_AT)

/** Line stages at which the line's equipment has left the Provider. */
const DELIVERED: ReadonlySet<LineStage> = new Set(LINE_ORDER.slice(SHIPPED_AT))

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
const REFILLABLE: readonly LineStage[] = LINE_ORDER.slice(LINE_ORDER.indexOf('awaiting_stock'), SHIPPED_AT + 1)

/**
 * Whether a unit that left its line in transit (`leftInTransit`) is taken off it and the line filled again: back to
 * awaiting stock and sourced again, with no new approval and its quantity unchanged. Not on a whole-Site recovery (site
 * decommission, agreement end), which brings everything back: filled again, the line would buy and send a unit to a
 * Site being emptied. Nor on a line installed, cancelled or new, which a unit still in transit never holds.
 */
export function refillsLine(line: { stage: LineStage; siteRecovery: boolean }): boolean {
    return !line.siteRecovery && REFILLABLE.includes(line.stage)
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

/**
 * The platform's task states an Order takes: Work in Progress from its approval on, and the state it closes with as
 * it ends complete (Closed Complete), rejected (Closed Incomplete) or cancelled (Closed Skipped).
 */
export const ORDER_TASK_STATE = {
    inProgress: TASK_STATE.workInProgress,
    complete: TASK_STATE.closedComplete,
    rejected: TASK_STATE.closedIncomplete,
    cancelled: TASK_STATE.closedSkipped,
} as const

/** The task state an Order is closed with as it enters `stage`; undefined for a stage that leaves it open. */
export function closedStateFor(stage: OrderStage): number | undefined {
    return stage === 'complete' || stage === 'rejected' || stage === 'cancelled' ? ORDER_TASK_STATE[stage] : undefined
}

/**
 * Stages in which an Order ended without delivering anything: nothing is sourced for it any more, even for a line a
 * refused save left open, and a replacement Order in one of them may be raised again (domain/breakfix).
 */
export const UNFULFILLED_ORDER_STAGES: readonly OrderStage[] = [ORDER_STAGE.rejected, ORDER_STAGE.cancelled]

/**
 * Whether an Order ended unfulfilled (cancelled or rejected): nothing is sourced, received or derived for its lines,
 * even one a refused save left open. Its cancel or rejection saves it before its lines.
 */
export function endedUnfulfilled(orderStage: string): boolean {
    return (UNFULFILLED_ORDER_STAGES as readonly string[]).includes(orderStage)
}

/** Stages in which an Order has ended, fulfilled or not. Every other Order is open (`OPEN_ORDERS_QUERY`). */
export const ENDED_ORDER_STAGES: readonly OrderStage[] = [ORDER_STAGE.complete, ORDER_STAGE.cancelled, ORDER_STAGE.rejected]

/**
 * Encoded query on x_daas_ham_order: the Orders that have not ended. A constant written out from the stage names, as
 * Fluent metadata reads no function call: its lists, modules and dashboard tiles import it (domain/fulfilment.test.ts
 * holds it to `ENDED_ORDER_STAGES`).
 */
export const OPEN_ORDERS_QUERY = `stageNOT IN${ORDER_STAGE.complete},${ORDER_STAGE.cancelled},${ORDER_STAGE.rejected}`

/** Encoded query on x_daas_ham_order: the Orders waiting for an approval, which the workspace lists and the dashboard counts. */
export const ORDERS_AWAITING_APPROVAL_QUERY = `stage=${ORDER_STAGE.awaiting_approval}`

/**
 * Stages in which Cancel order is offered: from a draft until Ship, before any of the Order's equipment is at its Site
 * (the action's condition is written from these; the built action is checked against them).
 */
export const CANCELLABLE_ORDER_STAGES: readonly OrderStage[] = [
    ORDER_STAGE.draft,
    ORDER_STAGE.awaiting_approval,
    ORDER_STAGE.sourcing,
    ORDER_STAGE.preparing,
    ORDER_STAGE.delivering,
]

/** Order stages its lines no longer move: before approval, and once it has ended. */
const SETTLED_ORDER_STAGES: readonly string[] = [ORDER_STAGE.draft, ORDER_STAGE.awaiting_approval, ...ENDED_ORDER_STAGES]

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
