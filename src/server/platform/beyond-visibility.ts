import type { GlideRecord } from '@servicenow/glide'
import { createMarks } from '../domain/marks.ts'

/**
 * Reads past the app's before-query visibility rules (ADR 0005), for server logic that must see every record whoever
 * set it off: the units of an Order line when its stage is derived, every device in a rack, the unit a receipt or a
 * device event names. On the app's own tables such a read may instead turn the business rules off (setWorkflow(false)); on a
 * table of another scope (alm_hardware) the platform refuses setWorkflow from this scope and runs the rules anyway, so
 * the read marks its GlideRecord here while its query runs and the app's rules leave that query as it is
 * (entry/visibility `scopeRecords`). Rules of other scopes, such as the platform's or Customer Service's, still run.
 *
 * Why the mark is the GlideRecord, held in this module (Brazil instance, 2026-11-09, probes in docs/research/
 * external-contracts.md N37): a module's state is shared by every script of one transaction, the caller's and the
 * rules its query sets off, and is gone in the next transaction, even one of the same session; a before-query rule's
 * `current` is the very GlideRecord whose query() or get() set it off; and no other scope can load this app's modules.
 * So only this app's code can mark a record, and the mark lets that record's own query through and nothing else: not
 * a query another rule makes meanwhile, not another request of the same user (a session's client data would reach
 * those), not a later transaction. It goes however the read ends, a nested read of the same record keeps it until the
 * outer one ends, and a transaction that dies before then takes it along. Should the platform ever hand the rules
 * another object, or share modules across transactions, the rules would narrow the read again, never skip another.
 */
const reading = createMarks<GlideRecord>()

/** `read` (the record's query() or get()) run past the app's before-query visibility rules; what it returns. */
export function beyondVisibility<T>(record: GlideRecord, read: () => T): T {
    return reading.during(record, read)
}

/** Whether `record`'s query is being run past the visibility rules: the before-query rules' check. */
export function readsBeyondVisibility(record: GlideRecord): boolean {
    return reading.has(record)
}
