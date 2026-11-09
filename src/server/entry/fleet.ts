// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { gs, type GlideRecord } from '@servicenow/glide'
import { adoptionProblem } from '../domain/fleet.ts'
import { fleetCandidate, joinFleet } from '../platform/assets.ts'
import { refusal, str } from '../platform/records.ts'

/** Adopting equipment the Provider already has into the fleet (ADR 0016). */

/**
 * UI action "Add to fleet" on an Asset (form button and list choice): the Asset becomes a fleet asset, which the app
 * then sources, stages, tracks and bills, when domain/fleet `adoptionProblem` allows it. As the app's other actions do,
 * it first saves the form, so a Stockroom, Site or Agreement typed before clicking counts, and stops when that save is
 * refused (the platform says why). alm_hardware is a global table, but what the platform refuses from this scope is a
 * rule's setAbortAction, not a save: the action saves the Asset as any script does, and a refused save is logged and
 * shown.
 */
export function uiAddToFleet(current: GlideRecord): void {
    if (!current.update()) return
    const name = str(current, 'asset_tag') || str(current, 'serial_number') || str(current, 'display_name')
    const problem = adoptionProblem(fleetCandidate(current))
    if (problem) return void gs.addErrorMessage(`${name} not added to the fleet: ${problem}`)
    joinFleet(current)
    if (current.update()) return void gs.addInfoMessage(`${name} added to the fleet`)
    const why = refusal(current)
    gs.warn(`[x_daas_ham] ${name} not added to the fleet: ${why}`)
    gs.addErrorMessage(`${name} not added to the fleet: ${why}`)
}
