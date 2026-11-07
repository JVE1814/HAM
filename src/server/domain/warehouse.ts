import type { Stage } from './lifecycle'
import type { StockroomType } from './sourcing'

/** What the warehouse scanning app (P1.5) may do with a scanned Asset, by its Lifecycle stage. */

/**
 * Receiving confirms bought units as available stock: in transit (an ASN row) or on order (created on receipt without
 * one). Any other Asset is already in stock, allocated or deployed, and receiving it would pull it out of its Stockroom
 * or drop its allocation. Returned units (pending return, missing) are received by the returns process instead.
 */
export function awaitsReceipt(stage: Stage | null): boolean {
    return stage === 'on_order' || stage === 'in_transit'
}

/**
 * Stockroom types arriving units (bought or returned) are received into: the Provider's central depots and staging
 * centres. A customer-site stockroom holds that Customer's own site stock: a bought unit received there would be
 * sourced only for that Customer's replacements, as a hot spare that skips staging, and a returned unit would await
 * evaluation away from the depot.
 */
export const RECEIVING_STOCKROOM_TYPES: readonly StockroomType[] = ['central_depot', 'staging_centre']

/** Why an arriving unit cannot be received into a Stockroom of this type, or null when it can. */
export function receivingProblem(into: StockroomType): string | null {
    return RECEIVING_STOCKROOM_TYPES.includes(into) ? null : 'Receive into a central depot or a staging centre'
}

/** In-stock stages whose Stockroom no allocation depends on: free stock and returned units still being worked on. */
const FREE_TO_MOVE: ReadonlySet<Stage> = new Set(['available', 'pending_evaluation', 'pending_wipe', 'pending_disposal'])

/**
 * Why an Asset cannot be put away into a Stockroom of this type, or null when it can. Free stock and returned units
 * awaiting evaluation, wipe or disposal go to any Stockroom. A unit being staged (one received for a waiting Order line
 * among them) goes only to a staging centre, where its Staging task and any transfer order expect it. Reserved,
 * spare-pool and staged Assets stay where their Order line, transfer order or Customer expects them, and nothing
 * outside stock is put away.
 */
export function putAwayProblem(stage: Stage | null, into: StockroomType): string | null {
    if (stage !== null && FREE_TO_MOVE.has(stage)) return null
    if (stage === 'staging') return into === 'staging_centre' ? null : 'A unit being staged is put away in a staging centre'
    return `Cannot be put away (${stage ?? 'unknown stage'})`
}
