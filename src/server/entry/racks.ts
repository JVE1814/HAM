// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideRecord, gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { placementProblem, powerBudget, type Placement, type RackFace, type RackSpec } from '../domain/rack.ts'
import { fleetCondition } from '../domain/fleet.ts'
import { RACK_EXCEPTION_TYPES, reconcileRack } from '../domain/reconciliation.ts'
import { visibilityFilter } from '../domain/visibility.ts'
import { isFleetAsset, readStage } from '../platform/assets.ts'
import { beyondVisibility } from '../platform/beyond-visibility.ts'
import { openException, resolveCiExceptions } from '../platform/exceptions.ts'
import { currentSession } from '../platform/session.ts'
import { exists, findById, num, pluck, recordsById, str } from '../platform/records.ts'
import { queryParam, reply } from '../platform/rest-api.ts'
import { reconcileInstalledBase } from './assurance.ts'

/** Rack placement and the rack elevation view (P2.8, D67). */

/** Where an Asset sits in its rack, and its Model (whose name, size and draw are read separately). */
interface Slot {
    assetId: string
    ruStart: number
    face: RackFace
    modelId: string
}

function slotOf(asset: GlideRecord): Slot {
    return {
        assetId: str(asset, 'asset_tag') || str(asset, 'serial_number'),
        ruStart: num(asset, 'x_daas_ham_ru_start'),
        face: (str(asset, 'x_daas_ham_rack_face') || 'front') as RackFace,
        modelId: str(asset, 'model'),
    }
}

/** What the rack checks and the elevation view need of a Model. */
interface RackModel {
    name: string
    rackUnits: number
    powerW: number
}

/** A missing or deleted Model reads as a dot-walk through a broken reference did: blank and zeros. */
const NO_MODEL: RackModel = { name: '', rackUnits: 0, powerW: 0 }

/** Name, rack units and typical power of each Model, read with one query. */
function rackModels(modelIds: readonly string[]): Map<string, RackModel> {
    return recordsById('cmdb_model', modelIds, (model) => ({
        name: str(model, 'display_name'),
        rackUnits: num(model, 'rack_units'),
        powerW: num(model, 'x_daas_ham_typical_power_w'),
    }))
}

function placementOf(slot: Slot, models: ReadonlyMap<string, RackModel>): Placement {
    const model = models.get(slot.modelId) ?? NO_MODEL
    return { assetId: slot.assetId, ruStart: slot.ruStart, height: Math.max(1, model.rackUnits), face: slot.face, powerW: model.powerW }
}

/**
 * Every fleet asset placed in the rack but `exceptAssetId`, past the visibility rules (ADR 0005): an inventory tech
 * sees only their Stockrooms' Assets, and a device they cannot see still fills its units and draws power
 * (platform/beyond-visibility). The Provider IT's equipment is left out (ADR 0016): the rules check no placement of
 * it, so a rack placement it carries is not known to hold until it joins the fleet, which is checked as placing it
 * (refusesKeptPlacement). Only read, never saved.
 */
function slotsIn(rackId: string, exceptAssetId = ''): Slot[] {
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('x_daas_ham_rack', rackId)
    asset.addEncodedQuery(fleetCondition())
    if (exceptAssetId) asset.addQuery('sys_id', '!=', exceptAssetId)
    asset.addNotNullQuery('x_daas_ham_ru_start')
    beyondVisibility(asset, () => asset.query())
    const slots: Slot[] = []
    while (asset.next()) slots.push(slotOf(asset))
    return slots
}

/**
 * Why the save cannot put the Asset where it is placed (a unit taken on its face, outside the rack, or past the rack's
 * power budget), or null when it fits or is not placed. It checks against the placements saved so far and takes no
 * lock: one taken here is released before the platform writes the record, so two saves into the same units at the
 * same moment could still both pass. Placements are entered by hand, one Asset per save, and no app logic places one,
 * so what slips through is reported, not refused: the after rule (recheckRackPlacement) re-checks the rack once the
 * save is written. A rack no longer there holds nothing, as for the re-check. A unit joining the fleet with its
 * placement is new to the rack as the checks count it (slotsIn counts fleet assets only), so its whole draw is added.
 */
function placementRefusal(current: GlideRecord, previous: GlideRecord | null): string | null {
    const rackId = str(current, 'x_daas_ham_rack')
    if (!rackId || !str(current, 'x_daas_ham_ru_start')) return null
    const rack = findById('cmdb_ci_rack', rackId)
    if (!rack) return null
    const others = slotsIn(rackId, current.getUniqueValue())
    const candidate = { ...slotOf(current), assetId: current.getUniqueValue() }
    // The Model this device already had in this rack, as a fleet asset; undefined when it is new to the rack or to
    // the fleet.
    const previousModelId =
        previous && isFleetAsset(previous) && str(previous, 'x_daas_ham_rack') === rackId && str(previous, 'x_daas_ham_ru_start')
            ? str(previous, 'model')
            : undefined
    // Every Model involved in one query; an unchanged Model is the candidate's own entry.
    const models = rackModels([candidate.modelId, previousModelId ?? '', ...others.map((slot) => slot.modelId)])
    const previousPowerW = previousModelId === undefined ? undefined : (models.get(previousModelId) ?? NO_MODEL).powerW
    const placements = others.map((slot) => placementOf(slot, models))
    return placementProblem(rackSpec(rack), placements, placementOf(candidate, models), previousPowerW)
}

/**
 * Condition of the before rule on alm_hardware (br_rack_placement): whether the save must be refused. The rule refuses
 * it with its Abort action, not with current.setAbortAction: the platform refuses that call from a scoped app on a
 * record of a global table ("Security restricted" in the script's output, nothing in the system log) and writes the
 * record anyway.
 */
export function refusesRackPlacement(current: GlideRecord, previous: GlideRecord | null): boolean {
    return placementRefusal(current, previous) !== null
}

/** The fields that place an Asset in its rack, which br_rack_placement's condition tests for a change. */
const PLACEMENT_FIELDS = ['x_daas_ham_rack', 'x_daas_ham_ru_start', 'x_daas_ham_rack_face'] as const

/**
 * Condition of the before rule on a racked Asset that gets a new Model or joins the fleet (br_rack_placement_model):
 * whether the save must be refused, as `refusesRackPlacement`, for a save that keeps the Asset's placement. A new
 * Model changes its height and draw. Joining the fleet ("Add to fleet" saves the form first, outside the fleet, then
 * only the flag) puts a placement no check counted into the rack, so it is checked as a device new to the rack. A
 * save that also sets the placement (an insert, or a new rack, lowest unit or face) is br_rack_placement's, which
 * checks it with the new Model and the flag as saved, so each save is checked, and refused with its message, once.
 */
export function refusesKeptPlacement(current: GlideRecord, previous: GlideRecord | null): boolean {
    const placementSet = !previous || PLACEMENT_FIELDS.some((field) => str(current, field) !== str(previous, field))
    return !placementSet && refusesRackPlacement(current, previous)
}

/** Script of those rules, run only when a condition refuses the save: why, as the error message. */
export function explainRackRefusal(current: GlideRecord, previous: GlideRecord | null): void {
    gs.addErrorMessage(placementRefusal(current, previous) ?? 'This rack placement is refused')
}

/**
 * After rule on alm_hardware: re-check the rack the Asset is placed in, and the one it left, now the save is written.
 * The before rule checks against the placements saved before, so two saves into the same units (or the last of a
 * rack's power) at the same moment can both pass it. Each after rule runs once its own save is written, so the later
 * of the two reads both and raises the exception; a later save that clears it resolves it.
 */
export function recheckRackPlacement(current: GlideRecord, previous: GlideRecord): void {
    const left = previous ? str(previous, 'x_daas_ham_rack') : ''
    for (const rackId of new Set([str(current, 'x_daas_ham_rack'), left])) if (rackId) recheckRack(rackId)
}

/**
 * The daily reconciliation job: the installed base against monitoring, then each rack with an open rack exception,
 * even when the first part throws. A rack exception resolves there when it cleared without a placement save (a
 * Model's size or power, the rack's capacity, a deleted Asset), or when a check raised it from a read taken just
 * before the save that cleared it: the open and the resolve take no lock in common.
 */
export function reconcileInstalledBaseAndRacks(): void {
    try {
        reconcileInstalledBase()
    } finally {
        const flagged = pluck('x_daas_ham_recon_exception', `status=open^exception_typeIN${RACK_EXCEPTION_TYPES.join(',')}^ciISNOTEMPTY`, 'ci')
        for (const rackId of new Set(flagged)) recheckRack(rackId)
    }
}

/**
 * Open the rack's overlap and power exceptions that a fresh read of the rack and every device placed in it finds
 * (domain/reconciliation `reconcileRack`), and resolve the others. A rack no longer there holds nothing, so its
 * exceptions resolve.
 */
function recheckRack(rackId: string): void {
    const rack = findById('cmdb_ci_rack', rackId)
    const found = rack ? reconcileRack(rackSpec(rack), placementsIn(rackId)) : []
    for (const { type, detail } of found) openException(type, { ciId: rackId, customerId: rack ? str(rack, 'company') : '', detail })
    resolveCiExceptions(rackId, RACK_EXCEPTION_TYPES.filter((type) => !found.some((exception) => exception.type === type)))
}

function rackSpec(rack: GlideRecord): RackSpec {
    return { units: num(rack, 'rack_units') || 42, powerCapacityW: num(rack, 'x_daas_ham_power_capacity_w') }
}

/** Every device placed in the rack, past the visibility rules, with its Model's height and draw. */
function placementsIn(rackId: string): Placement[] {
    const slots = slotsIn(rackId)
    const models = rackModels(slots.map((slot) => slot.modelId))
    return slots.map((slot) => placementOf(slot, models))
}

function forbidden(response: RESTAPIResponse): boolean {
    if (currentSession().scope !== 'unscoped') return false
    reply(response, 403, { error: 'Requires a NaaS role' })
    return true
}

/** The fields of a Location that carry the Customer and the Site for the visibility rules. */
const LOCATION_FIELDS = { customer: 'company', site: 'sys_id' }

/** A Location that is a customer Site, the app's discriminator on cmn_location (ADR 0016). */
const SITE = 'x_daas_ham_is_site=true'

/**
 * Whether one of `locationIds` (a Site, or a Room in it, and the Room's parent) is a Site the user may see: staff see
 * every Site, customer admins their Customer's and site contacts their own. A location that is no Site, such as a
 * data-centre room of the Provider IT's, holds no rack the app places fleet assets in (ADR 0016), and its racks are
 * shown to no one, staff included. Locations have no before-query rule, so the rack endpoints check this before
 * reading a rack. The ids go into an encoded query, so they must be sys_ids read from records, never values taken
 * from the request.
 */
function seesSite(locationIds: readonly string[]): boolean {
    const ids = locationIds.filter(Boolean)
    if (ids.length === 0) return false
    const session = currentSession()
    const filter = visibilityFilter(session.scope, LOCATION_FIELDS, session)
    return exists('cmn_location', [`sys_idIN${ids.join(',')}`, SITE, ...(filter ? [filter] : [])].join('^'))
}

/** GET /racks?site={sys_id}: racks at the Site and in its rooms. */
export function listRacks(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (forbidden(response)) return
    // The Site is read first so the visibility check and the rack query below use the same sys_id.
    const site = findById('cmn_location', queryParam(request, 'site'))
    if (!site || !seesSite([site.getUniqueValue()])) {
        reply(response, 404, { error: 'No such site' })
        return
    }
    const siteId = site.getUniqueValue()
    const rack = new GlideRecord('cmdb_ci_rack')
    const atSite = rack.addQuery('location', siteId)
    atSite.addOrCondition('location.parent', siteId)
    rack.orderBy('name')
    rack.query()
    const racks: Array<{ id: string; name: string; units: number; room: string }> = []
    while (rack.next()) {
        racks.push({ id: rack.getUniqueValue(), name: str(rack, 'name'), units: num(rack, 'rack_units') || 42, room: rack.getDisplayValue('location') })
    }
    reply(response, 200, { racks })
}

/** GET /racks/{id}: the rack and the fleet assets placed in it (visibility rules apply to devices). */
export function getRack(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (forbidden(response)) return
    const rack = new GlideRecord('cmdb_ci_rack')
    // A rack stands in a Room of the Site (or at the Site itself), as GET /racks lists it.
    if (!rack.get(String(request.pathParams.id ?? '')) || !seesSite([str(rack, 'location'), str(rack, 'location.parent')])) {
        reply(response, 404, { error: 'No such rack' })
        return
    }
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('x_daas_ham_rack', rack.getUniqueValue())
    asset.addEncodedQuery(fleetCondition())
    asset.addNotNullQuery('x_daas_ham_ru_start')
    asset.query()
    const found: Array<{ slot: Slot; companyId: string; device: Record<string, unknown> }> = []
    while (asset.next()) {
        found.push({
            slot: slotOf(asset),
            companyId: str(asset, 'company'),
            device: {
                id: asset.getUniqueValue(),
                tag: str(asset, 'asset_tag'),
                serial: str(asset, 'serial_number'),
                stage: readStage(asset) ?? 'unknown',
                lifecyclePhase: str(asset, 'x_daas_ham_lifecycle_phase'),
                coverageEnd: str(asset, 'x_daas_ham_coverage_end'),
                refreshDue: str(asset, 'x_daas_ham_refresh_due'),
            },
        })
    }
    // Models and Customer names each read with one query.
    const models = rackModels(found.map(({ slot }) => slot.modelId))
    const customerNames = recordsById('core_company', found.map(({ companyId }) => companyId), (company) => str(company, 'name'))
    const placements = found.map(({ slot }) => placementOf(slot, models))
    const devices = found.map(({ slot, companyId, device }, i) => ({
        ...device,
        customer: customerNames.get(companyId) ?? '',
        model: (models.get(slot.modelId) ?? NO_MODEL).name,
        ruStart: placements[i].ruStart,
        height: placements[i].height,
        face: placements[i].face,
    }))
    // The budget counts the devices listed above, so the same visibility rules apply to it.
    const power = powerBudget(num(rack, 'x_daas_ham_power_capacity_w'), placements)
    reply(response, 200, { rack: { id: rack.getUniqueValue(), name: str(rack, 'name'), units: num(rack, 'rack_units') || 42, power }, devices })
}

/** GET /sites: customer Sites the user may see (customers only their own, site contacts only theirs). */
export function listSites(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (forbidden(response)) return
    const session = currentSession()
    const site = new GlideRecord('cmn_location')
    site.addEncodedQuery(SITE)
    const filter = visibilityFilter(session.scope, LOCATION_FIELDS, session)
    if (filter) site.addEncodedQuery(filter)
    site.orderBy('name')
    site.setLimit(1000)
    site.query()
    const sites: Array<{ id: string; name: string; customer: string }> = []
    while (site.next()) sites.push({ id: site.getUniqueValue(), name: str(site, 'name'), customer: site.getDisplayValue('company') })
    reply(response, 200, { sites })
}
