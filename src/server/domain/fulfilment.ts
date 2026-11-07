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

export function lineStageFor(line: { quantity: number; assetStages: ReadonlyArray<Stage | null>; cancelled: boolean }): LineStage {
    if (line.cancelled || line.quantity <= 0) return 'cancelled'
    const progress = line.assetStages.map((stage) => (stage ? PROGRESS[stage] : undefined)).filter((p): p is number => p !== undefined)
    if (progress.length < line.quantity) return 'awaiting_stock'
    return LINE_FOR_PROGRESS[Math.min(...progress)]
}

const LINE_ORDER: readonly LineStage[] = ['new', 'awaiting_stock', 'sourced', 'staging', 'ready_to_ship', 'shipped', 'installed', 'in_service']

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
