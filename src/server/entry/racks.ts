// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideRecord, gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { placementProblem, powerBudget, type Placement, type RackFace } from '../domain/rack'
import { visibilityFilter } from '../domain/visibility'
import { readStage } from '../platform/assets'
import { currentSession } from '../platform/session'
import { num, str } from '../platform/records'
import { queryParam, reply } from '../platform/rest-api'

/** Rack placement and the rack elevation view (P2.8, D67). */

function heightOf(asset: GlideRecord): number {
    return Math.max(1, num(asset, 'model.rack_units'))
}

function placementOf(asset: GlideRecord): Placement {
    return {
        assetId: str(asset, 'asset_tag') || str(asset, 'serial_number'),
        ruStart: num(asset, 'x_daas_ham_ru_start'),
        height: heightOf(asset),
        face: (str(asset, 'x_daas_ham_rack_face') || 'front') as RackFace,
        powerW: num(asset, 'model.x_daas_ham_typical_power_w'),
    }
}

function placementsIn(rackId: string, exceptAssetId: string): Placement[] {
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('x_daas_ham_rack', rackId)
    asset.addQuery('sys_id', '!=', exceptAssetId)
    asset.addNotNullQuery('x_daas_ham_ru_start')
    asset.query()
    const placements: Placement[] = []
    while (asset.next()) placements.push(placementOf(asset))
    return placements
}

/** Before rule on alm_hardware: a rack position must be free, inside the rack and within its power budget. */
export function guardRackPlacement(current: GlideRecord, previous: GlideRecord): void {
    const rackId = str(current, 'x_daas_ham_rack')
    if (!rackId || !str(current, 'x_daas_ham_ru_start')) return
    // The draw this device already had in this rack; undefined when it is new to the rack.
    const previousPowerW =
        previous && str(previous, 'x_daas_ham_rack') === rackId && str(previous, 'x_daas_ham_ru_start') ? num(previous, 'model.x_daas_ham_typical_power_w') : undefined
    const rack = { units: num(current, 'x_daas_ham_rack.rack_units') || 42, powerCapacityW: num(current, 'x_daas_ham_rack.x_daas_ham_power_capacity_w') }
    const candidate = { ...placementOf(current), assetId: current.getUniqueValue() }
    const problem = placementProblem(rack, placementsIn(rackId, current.getUniqueValue()), candidate, previousPowerW)
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
    const devices: object[] = []
    const placements: Placement[] = []
    while (asset.next()) {
        const placement = placementOf(asset)
        placements.push(placement)
        devices.push({
            id: asset.getUniqueValue(),
            tag: str(asset, 'asset_tag'),
            serial: str(asset, 'serial_number'),
            model: asset.getDisplayValue('model'),
            ruStart: placement.ruStart,
            height: placement.height,
            face: placement.face,
            stage: readStage(asset) ?? 'unknown',
            customer: asset.getDisplayValue('company'),
            lifecyclePhase: str(asset, 'x_daas_ham_lifecycle_phase'),
            coverageEnd: str(asset, 'x_daas_ham_coverage_end'),
            refreshDue: str(asset, 'x_daas_ham_refresh_due'),
        })
    }
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
