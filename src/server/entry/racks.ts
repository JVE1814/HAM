// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideRecord, gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { memoized } from '../domain/memo'
import { placementProblem, powerBudget, type Placement, type RackFace } from '../domain/rack'
import { visibilityFilter } from '../domain/visibility'
import { readStage } from '../platform/assets'
import { currentSession } from '../platform/session'
import { num, recordsById, str } from '../platform/records'
import { queryParam, reply } from '../platform/rest-api'

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

function slotsIn(rackId: string, exceptAssetId: string): Slot[] {
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('x_daas_ham_rack', rackId)
    asset.addQuery('sys_id', '!=', exceptAssetId)
    asset.addNotNullQuery('x_daas_ham_ru_start')
    asset.query()
    const slots: Slot[] = []
    while (asset.next()) slots.push(slotOf(asset))
    return slots
}

/** Before rule on alm_hardware: a rack position must be free, inside the rack and within its power budget. */
export function guardRackPlacement(current: GlideRecord, previous: GlideRecord): void {
    const rackId = str(current, 'x_daas_ham_rack')
    if (!rackId || !str(current, 'x_daas_ham_ru_start')) return
    const others = slotsIn(rackId, current.getUniqueValue())
    const candidate = { ...slotOf(current), assetId: current.getUniqueValue() }
    // The Model this device already had in this rack; undefined when it is new to the rack.
    const previousModelId =
        previous && str(previous, 'x_daas_ham_rack') === rackId && str(previous, 'x_daas_ham_ru_start') ? str(previous, 'model') : undefined
    // Every Model involved in one query; an unchanged Model is the candidate's own entry.
    const models = rackModels([candidate.modelId, previousModelId ?? '', ...others.map((slot) => slot.modelId)])
    const previousPowerW = previousModelId === undefined ? undefined : (models.get(previousModelId) ?? NO_MODEL).powerW
    const rack = { units: num(current, 'x_daas_ham_rack.rack_units') || 42, powerCapacityW: num(current, 'x_daas_ham_rack.x_daas_ham_power_capacity_w') }
    const placements = others.map((slot) => placementOf(slot, models))
    const problem = placementProblem(rack, placements, placementOf(candidate, models), previousPowerW)
    if (problem) {
        gs.addErrorMessage(problem)
        current.setAbortAction(true)
    }
}

function forbidden(response: RESTAPIResponse): boolean {
    if (currentSession().scope !== 'unscoped') return false
    reply(response, 403, { error: 'Requires a NaaS role' })
    return true
}

/** GET /racks?site={sys_id}: racks in the Site's rooms. */
export function listRacks(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (forbidden(response)) return
    const siteId = queryParam(request, 'site')
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

/** GET /racks/{id}: the rack and the devices placed in it (visibility rules apply to devices). */
export function getRack(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (forbidden(response)) return
    const rack = new GlideRecord('cmdb_ci_rack')
    if (!rack.get(String(request.pathParams.id ?? ''))) {
        reply(response, 404, { error: 'No such rack' })
        return
    }
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('x_daas_ham_rack', rack.getUniqueValue())
    asset.addNotNullQuery('x_daas_ham_ru_start')
    asset.query()
    // Read from the device in hand, once per Customer.
    const customerName = memoized(() => asset.getDisplayValue('company'))
    const found: Array<{ slot: Slot; device: Record<string, unknown> }> = []
    while (asset.next()) {
        found.push({
            slot: slotOf(asset),
            device: {
                id: asset.getUniqueValue(),
                tag: str(asset, 'asset_tag'),
                serial: str(asset, 'serial_number'),
                stage: readStage(asset) ?? 'unknown',
                customer: customerName(str(asset, 'company')),
                lifecyclePhase: str(asset, 'x_daas_ham_lifecycle_phase'),
                coverageEnd: str(asset, 'x_daas_ham_coverage_end'),
                refreshDue: str(asset, 'x_daas_ham_refresh_due'),
            },
        })
    }
    const models = rackModels(found.map(({ slot }) => slot.modelId))
    const placements = found.map(({ slot }) => placementOf(slot, models))
    const devices = found.map(({ slot, device }, i) => ({
        ...device,
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
    site.addQuery('x_daas_ham_is_site', true)
    const filter = visibilityFilter(session.scope, { customer: 'company', site: 'sys_id' }, session)
    if (filter) site.addEncodedQuery(filter)
    site.orderBy('name')
    site.setLimit(1000)
    site.query()
    const sites: Array<{ id: string; name: string; customer: string }> = []
    while (site.next()) sites.push({ id: site.getUniqueValue(), name: str(site, 'name'), customer: site.getDisplayValue('company') })
    reply(response, 200, { sites })
}
