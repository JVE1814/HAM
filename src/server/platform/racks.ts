import { GlideRecord } from '@servicenow/glide'
import { fleetCondition, SITE_CONDITION } from '../domain/fleet.ts'
import {
    DEFAULT_RACK_FACE,
    DEFAULT_RACK_UNITS,
    devicePlacement,
    PLACEMENT_FIELDS,
    placementProblem,
    powerBudget,
    RACK_FACES,
    type Placement,
    type RackSpec,
} from '../domain/rack.ts'
import { RACK_EXCEPTION_TYPES, reconcileRack } from '../domain/reconciliation.ts'
import type { RackDevice, RackElevation, RackListing, Site } from '../domain/rest-contracts.ts'
import { visibilityFilter, type TableScoping } from '../domain/visibility.ts'
import type { RackFace } from '../domain/vocabulary.ts'
import { isFleetAsset, readStage } from './assets.ts'
import { beyondVisibility } from './beyond-visibility.ts'
import { cisWithOpenException, settleExceptions } from './exceptions.ts'
import { choice, exists, findById, num, recordsById, str, type ForeignRecord } from './records.ts'
import { currentSession } from './session.ts'

/**
 * Racks: where fleet assets are placed, whether a placement fits (P2.8), the rack exceptions (D67) and the reads of
 * the rack elevation view. None of it tells the user anything: each gives what it found, for the trigger that asked.
 */

/** Where an Asset sits in its rack, and its Model (whose name, size and draw are read separately). */
interface Slot {
    /** The Asset's sys_id: the Placement's key, read the same way for the candidate and for the rack's other devices. */
    id: string
    tag: string
    serial: string
    ruStart: number
    face: RackFace
    modelId: string
}

function slotOf(asset: ForeignRecord): Slot {
    return {
        id: asset.getUniqueValue(),
        tag: str(asset, 'asset_tag'),
        serial: str(asset, 'serial_number'),
        ruStart: num(asset, PLACEMENT_FIELDS.ruStart),
        face: choice(asset, PLACEMENT_FIELDS.face, RACK_FACES, DEFAULT_RACK_FACE),
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

/** Name, rack units and typical power (the platform's cmdb_model.power_consumption, in watts) of each Model, read with one query. */
function rackModels(modelIds: readonly string[]): Map<string, RackModel> {
    return recordsById('cmdb_model', modelIds, (model) => ({
        name: str(model, 'display_name'),
        rackUnits: num(model, 'rack_units'),
        powerW: num(model, 'power_consumption'),
    }))
}

function placementOf(slot: Slot, models: ReadonlyMap<string, RackModel>): Placement {
    const model = models.get(slot.modelId) ?? NO_MODEL
    return devicePlacement({ ...slot, height: model.rackUnits, powerW: model.powerW })
}

function rackSpec(rack: GlideRecord): RackSpec {
    return { units: num(rack, 'rack_units') || DEFAULT_RACK_UNITS, powerCapacityW: num(rack, 'x_daas_ham_power_capacity_w') }
}

/**
 * The fleet assets placed in the rack, as a query not yet run: the checks run it past the visibility rules (`slotsIn`),
 * the elevation view within them (`rackElevation`). The Provider IT's equipment is left out (ADR 0016): the rules check
 * no placement of it, so a rack placement it carries is not known to hold until it joins the fleet, which is checked
 * as placing it (`keepsPlacement`).
 */
function placedIn(rackId: string): GlideRecord {
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery(PLACEMENT_FIELDS.rack, rackId)
    asset.addEncodedQuery(fleetCondition())
    asset.addNotNullQuery(PLACEMENT_FIELDS.ruStart)
    return asset
}

/**
 * Every fleet asset placed in the rack but `exceptAssetId`, past the visibility rules (ADR 0005): an inventory tech
 * sees only their Stockrooms' Assets, and a device they cannot see still fills its units and draws power
 * (platform/beyond-visibility). Only read, never saved.
 */
function slotsIn(rackId: string, exceptAssetId = ''): Slot[] {
    const asset = placedIn(rackId)
    if (exceptAssetId) asset.addQuery('sys_id', '!=', exceptAssetId)
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
 * so what slips through is reported, not refused: the after rule (`recheckRack`) re-checks the rack once the save is
 * written. A rack no longer there holds nothing, as for the re-check. A unit joining the fleet with its placement is
 * new to the rack as the checks count it (slotsIn counts fleet assets only), so its whole draw is added.
 */
export function placementRefusal(current: ForeignRecord, previous: ForeignRecord | null): string | null {
    const rackId = str(current, PLACEMENT_FIELDS.rack)
    if (!rackId || !str(current, PLACEMENT_FIELDS.ruStart)) return null
    const rack = findById('cmdb_ci_rack', rackId)
    if (!rack) return null
    const candidate = slotOf(current)
    const others = slotsIn(rackId, candidate.id)
    // The Model this device already had in this rack, as a fleet asset; undefined when it is new to the rack or to
    // the fleet.
    const previousModelId =
        previous && isFleetAsset(previous) && str(previous, PLACEMENT_FIELDS.rack) === rackId && str(previous, PLACEMENT_FIELDS.ruStart)
            ? str(previous, 'model')
            : undefined
    // Every Model involved in one query; an unchanged Model is the candidate's own entry.
    const models = rackModels([candidate.modelId, previousModelId ?? '', ...others.map((slot) => slot.modelId)])
    const previousPowerW = previousModelId === undefined ? undefined : (models.get(previousModelId) ?? NO_MODEL).powerW
    const placements = others.map((slot) => placementOf(slot, models))
    return placementProblem(rackSpec(rack), placements, placementOf(candidate, models), previousPowerW)
}

/** Whether the save leaves the Asset where it was placed: not an insert, and its rack, lowest unit and face unchanged. */
export function keepsPlacement(current: ForeignRecord, previous: ForeignRecord | null): boolean {
    return !!previous && Object.values(PLACEMENT_FIELDS).every((field) => str(current, field) === str(previous, field))
}

/** Every device placed in the rack, past the visibility rules, with its Model's height and draw. */
function placementsIn(rackId: string): Placement[] {
    const slots = slotsIn(rackId)
    const models = rackModels(slots.map((slot) => slot.modelId))
    return slots.map((slot) => placementOf(slot, models))
}

/**
 * Open the rack's overlap and power exceptions that a fresh read of the rack and every device placed in it finds
 * (domain/reconciliation `reconcileRack`), and resolve the others. A rack no longer there holds nothing, so its
 * exceptions resolve.
 */
function recheckRack(rackId: string): void {
    const rack = findById('cmdb_ci_rack', rackId)
    const found = rack ? reconcileRack(rackSpec(rack), placementsIn(rackId)) : []
    settleExceptions({ ciId: rackId }, rack ? str(rack, 'company') : '', RACK_EXCEPTION_TYPES, found)
}

/** Re-check the rack a saved Asset is placed in, and the one the save took it out of (`recheckRack`), each once. */
export function recheckRacksOf(current: ForeignRecord, previous: ForeignRecord | null): void {
    const left = previous ? str(previous, PLACEMENT_FIELDS.rack) : ''
    for (const rackId of new Set([str(current, PLACEMENT_FIELDS.rack), left])) if (rackId) recheckRack(rackId)
}

/**
 * Re-check each rack with an open rack exception. One resolves here when it cleared without a placement save (a
 * Model's size or power, the rack's capacity, a deleted Asset), or when a check raised it from a read taken just
 * before the save that cleared it: the open and the resolve take no lock in common.
 */
export function recheckFlaggedRacks(): void {
    for (const rackId of cisWithOpenException(RACK_EXCEPTION_TYPES)) recheckRack(rackId)
}

/**
 * The fields of a Location that carry the Customer and the Site for the visibility filter. Kept here and out of
 * domain/visibility `SCOPED_TABLES`: that map lists the tables the app scopes with a before-query rule or a read ACL,
 * and the app puts neither on cmn_location, which it shares with the Provider's IT (ADR 0016). Only the rack endpoints
 * narrow Locations, through this.
 */
const LOCATION_SCOPING: TableScoping = { customer: 'company', site: 'sys_id' }

/** The reader's visibility filter on Locations, or null for staff, who see every Site. */
function siteFilter(): string | null {
    const session = currentSession()
    return visibilityFilter(session.scope, LOCATION_SCOPING, session)
}

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
    const filter = siteFilter()
    return exists('cmn_location', [`sys_idIN${ids.join(',')}`, SITE_CONDITION, ...(filter ? [filter] : [])].join('^'))
}

/** The most Sites the page's picker lists. */
const SITES_LISTED = 1000

/** The customer Sites the user may see, by name (customers only their own, site contacts only theirs). */
export function visibleSites(): Site[] {
    const site = new GlideRecord('cmn_location')
    site.addEncodedQuery(SITE_CONDITION)
    const filter = siteFilter()
    if (filter) site.addEncodedQuery(filter)
    site.orderBy('name')
    site.setLimit(SITES_LISTED)
    site.query()
    const sites: Site[] = []
    while (site.next()) sites.push({ id: site.getUniqueValue(), name: str(site, 'name'), customer: site.getDisplayValue('company') })
    return sites
}

/** The racks at a Site and in its rooms, by name; null when `siteId` names no Site the user may see. */
export function racksAtSite(siteId: string): RackListing[] | null {
    // The Site is read first so the visibility check and the rack query below use the same sys_id.
    const site = findById('cmn_location', siteId)
    if (!site || !seesSite([site.getUniqueValue()])) return null
    const rack = new GlideRecord('cmdb_ci_rack')
    const atSite = rack.addQuery('location', site.getUniqueValue())
    atSite.addOrCondition('location.parent', site.getUniqueValue())
    rack.orderBy('name')
    rack.query()
    const racks: RackListing[] = []
    while (rack.next()) racks.push({ id: rack.getUniqueValue(), name: str(rack, 'name'), room: rack.getDisplayValue('location') })
    return racks
}

/**
 * The rack and the fleet assets placed in it, as the user may see them (the visibility rules apply to the devices);
 * null when `rackId` names no rack at a Site the user may see.
 */
export function rackElevation(rackId: string): RackElevation | null {
    const rack = new GlideRecord('cmdb_ci_rack')
    // A rack stands in a Room of the Site (or at the Site itself), as `racksAtSite` lists it.
    if (!rack.get(rackId) || !seesSite([str(rack, 'location'), str(rack, 'location.parent')])) return null
    const asset = placedIn(rack.getUniqueValue())
    asset.query()
    const found: Array<{ slot: Slot; companyId: string; device: Omit<RackDevice, 'customer' | 'model' | 'ruStart' | 'height' | 'face'> }> = []
    while (asset.next()) {
        found.push({
            slot: slotOf(asset),
            companyId: str(asset, 'company'),
            device: {
                id: asset.getUniqueValue(),
                tag: str(asset, 'asset_tag'),
                serial: str(asset, 'serial_number'),
                stage: readStage(asset) ?? 'unknown',
                lifecyclePhase: str(asset, 'x_daas_ham_lifecycle_phase') as RackDevice['lifecyclePhase'],
                coverageEnd: str(asset, 'x_daas_ham_coverage_end'),
                refreshDue: str(asset, 'x_daas_ham_refresh_due'),
            },
        })
    }
    // Models and Customer names each read with one query.
    const models = rackModels(found.map(({ slot }) => slot.modelId))
    const customerNames = recordsById('core_company', found.map(({ companyId }) => companyId), (company) => str(company, 'name'))
    const placements = found.map(({ slot }) => placementOf(slot, models))
    const devices: RackDevice[] = found.map(({ slot, companyId, device }, i) => ({
        ...device,
        customer: customerNames.get(companyId) ?? '',
        model: (models.get(slot.modelId) ?? NO_MODEL).name,
        ruStart: placements[i].ruStart,
        height: placements[i].height,
        face: placements[i].face,
    }))
    const spec = rackSpec(rack)
    // The budget counts the devices listed above, so the same visibility rules apply to it.
    const power = powerBudget(spec.powerCapacityW, placements)
    return { rack: { id: rack.getUniqueValue(), name: str(rack, 'name'), units: spec.units, power }, devices }
}
