import type { Stage } from './lifecycle'

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

/** How far an allocated Asset has progressed along fulfilment (higher is further). */
const PROGRESS: Partial<Record<Stage, number>> = {
    reserved: 1,
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

const LINE_ORDER: readonly LineStage[] = ['new', 'awaiting_stock', 'sourced', 'staging', 'ready_to_ship', 'shipped', 'installed', 'in_service']

/** Line stages at which the line's equipment has left the Provider. */
const DELIVERED: ReadonlySet<LineStage> = new Set(['shipped', 'installed', 'in_service'])

/** What a line's stage is derived from. */
export interface LineFacts {
    /** The stage the line is in now. */
    current: LineStage
    quantity: number
    assetStages: ReadonlyArray<Stage | null>
}

/**
 * The stage a line at `current` takes from its Assets. Once delivered it only moves forward, following the Assets still
 * on their way into service: one that leaves (a return, a swap-back of a dead-on-arrival unit, declared missing) neither
 * sends the line back nor holds it up, as nothing re-sources a delivered line.
 */
export function lineStageFor(line: LineFacts): LineStage {
    if (line.current === 'cancelled' || line.quantity <= 0) return 'cancelled'
    const progress = line.assetStages.map((stage) => (stage ? PROGRESS[stage] : undefined)).filter((p): p is number => p !== undefined)
    if (!DELIVERED.has(line.current)) {
        return progress.length < line.quantity ? 'awaiting_stock' : LINE_FOR_PROGRESS[Math.min(...progress)]
    }
    const derived = progress.length > 0 ? LINE_FOR_PROGRESS[Math.min(...progress)] : line.current
    return LINE_ORDER.indexOf(derived) > LINE_ORDER.indexOf(line.current) ? derived : line.current
}

/** Order stages its lines no longer move: before approval, and once rejected, cancelled or complete. */
const SETTLED_ORDER_STAGES: readonly string[] = ['draft', 'awaiting_approval', 'rejected', 'cancelled', 'complete']

/** Whether an Order's stage still follows its lines (a complete Order stays complete when its Assets leave service). */
export function followsLines(orderStage: string): boolean {
    return !SETTLED_ORDER_STAGES.includes(orderStage)
}

export function orderStageFor(lineStages: readonly LineStage[]): OrderStage {
    const live = lineStages.filter((s) => s !== 'cancelled')
    if (live.length === 0) return 'cancelled'
    const slowest = live.reduce((a, b) => (LINE_ORDER.indexOf(a) <= LINE_ORDER.indexOf(b) ? a : b))
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
        default:
            return 'complete'
    }
}
