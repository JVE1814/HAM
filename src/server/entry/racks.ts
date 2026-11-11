import { gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import type { RackList, SiteList } from '../domain/rest-contracts.ts'
import { RACK_PAGE_USERS } from '../domain/roles.ts'
import { keepsPlacement, placementRefusal, rackElevation, racksAtSite, recheckFlaggedRacks, recheckRacksOf, visibleSites } from '../platform/racks.ts'
import { reconcileInstalledBase } from '../platform/reconciliation.ts'
import type { ForeignRecord } from '../platform/records.ts'
import { pathParam, queryParam, reply, requireRole } from '../platform/rest-api.ts'

/** Rack placement and the rack elevation view (P2.8, Q67). */

/**
 * Condition of the before rule on alm_hardware (br_rack_placement): whether the save must be refused. The rule refuses
 * it with its Abort action, not with current.setAbortAction: the platform refuses that call from a scoped app on a
 * record of a global table ("Security restricted" in the script's output, nothing in the system log) and writes the
 * record anyway.
 */
export function refusesRackPlacement(current: ForeignRecord, previous: ForeignRecord | null): boolean {
    return placementRefusal(current, previous) !== null
}

/**
 * Condition of the before rule on a racked Asset that gets a new Model or joins the fleet (br_rack_placement_model):
 * whether the save must be refused, as `refusesRackPlacement`, for a save that keeps the Asset's placement. A new
 * Model changes its height and draw. Joining the fleet ("Add to fleet" saves the form first, outside the fleet, then
 * only the flag) puts a placement no check counted into the rack, so it is checked as a device new to the rack. A
 * save that also sets the placement (an insert, or a new rack, lowest unit or face) is br_rack_placement's, which
 * checks it with the new Model and the flag as saved, so each save is checked, and refused with its message, once.
 */
export function refusesKeptPlacement(current: ForeignRecord, previous: ForeignRecord | null): boolean {
    return keepsPlacement(current, previous) && refusesRackPlacement(current, previous)
}

/**
 * Script of those rules, run only when a condition refuses the save: why, as the error message. The condition's
 * answer does not reach the script, so the placement is checked again for its reason.
 */
export function explainRackRefusal(current: ForeignRecord, previous: ForeignRecord | null): void {
    gs.addErrorMessage(placementRefusal(current, previous) ?? 'This rack placement is refused')
}

/**
 * After rule on alm_hardware: re-check the rack the Asset is placed in, and the one it left, now the save is written.
 * The before rule checks against the placements saved before, so two saves into the same units (or the last of a
 * rack's power) at the same moment can both pass it. Each after rule runs once its own save is written, so the later
 * of the two reads both and raises the exception; a later save that clears it resolves it.
 */
export function recheckRackPlacement(current: ForeignRecord, previous: ForeignRecord): void {
    recheckRacksOf(current, previous)
}

export function reconcileInstalledBaseAndRacks(): void {
    try {
        reconcileInstalledBase()
    } finally {
        recheckFlaggedRacks()
    }
}

function allowed(response: RESTAPIResponse): boolean {
    return requireRole(response, RACK_PAGE_USERS, 'Requires a NaaS role')
}

export function listRacks(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const racks = racksAtSite(queryParam(request, 'site'))
    if (!racks) return reply(response, 404, { error: 'No such site' })
    reply(response, 200, { racks } satisfies RackList)
}

export function getRack(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const elevation = rackElevation(pathParam(request, 'id'))
    if (!elevation) return reply(response, 404, { error: 'No such rack' })
    reply(response, 200, elevation)
}

export function listSites(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    reply(response, 200, { sites: visibleSites() } satisfies SiteList)
}
