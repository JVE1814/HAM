import type { GlideRecord } from '@servicenow/glide'
import { EVENT } from '../domain/events.ts'
import { fire, requeueCounted, timesRequeued } from './events.ts'
import { findById, str } from './records.ts'

/**
 * The requests the sourcing event (domain/events `EVENT.sourceOrder`) carries on an Order: a sourcing pass, or a
 * submission queued again because its Agreement's usage lock was held (platform/orders `submitLater`). Both are
 * written and read here.
 */

/** parm1 of the sourcing event when it carries a submission queued again; '' for a sourcing pass. */
const SUBMIT_AGAIN = 'submit'

export interface SourcingRequestEvent {
    request: 'pass' | 'submission'
    tries: number
}

export function sourcingRequestOf(event: GlideRecord): SourcingRequestEvent {
    return { request: str(event, 'parm1') === SUBMIT_AGAIN ? 'submission' : 'pass', tries: timesRequeued(event) }
}

/**
 * Queue a sourcing pass of the Order (the event's script action sources its lines that are new or awaiting stock):
 * once approved, for a line that lost a unit, or for a unit received for a line and not reserved for it. Queued, not
 * run: sourcing takes the Order's sourcing lock and saves other Assets, and the saves that ask for it hold locks of
 * their own (ADR 0013).
 */
export function queueSourcing(orderId: string): void {
    const order = findById('x_daas_ham_order', orderId)
    if (order) fire(EVENT.sourceOrder, order)
}

/** Queue a sourcing pass of `order` again a minute later, unless it was already queued again `tries` times (false). */
export function queuePassAgain(order: GlideRecord, tries: number): boolean {
    return requeueCounted(EVENT.sourceOrder, order, '', tries)
}

/** Queue the submission of `order` again a minute later, unless it was already queued again `tries` times (false). */
export function queueSubmissionAgain(order: GlideRecord, tries: number): boolean {
    return requeueCounted(EVENT.sourceOrder, order, SUBMIT_AGAIN, tries)
}
