import { gs, type GlideRecord } from '@servicenow/glide'

/**
 * Abort the save or delete of `current` with `why` as its error message, unless there is none. For a before rule on one
 * of the app's own tables: on a record of a global table the platform refuses setAbortAction from this scope, so those
 * rules refuse with their Abort action (entry/racks `refusesRackPlacement`).
 */
export function abortWith(current: GlideRecord, why: string | null): void {
    if (!why) return
    gs.addErrorMessage(why)
    current.setAbortAction(true)
}
