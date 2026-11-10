import { andEachClause } from './encoded-query.ts'
import { stagesQuery, type Stage } from './lifecycle.ts'
import { INSTALL_STATUS, STAGE_FIELDS, STOCKROOM_TYPE, type StockroomType } from './vocabulary.ts'

/**
 * Fleet assets (ADR 0016): the equipment the Provider runs as part of the network service, which is all this app acts
 * on. The platform tables are shared with the Provider's own IT, so each NaaS record is told apart explicitly:
 *
 * - an Asset by its Fleet flag (`alm_hardware.x_daas_ham_fleet`), set by every path through which the app creates or
 *   takes in a unit, and by "Add to fleet" for equipment the Provider already has;
 * - a Stockroom by its stockroom type: one with no type is not a NaaS stockroom;
 * - a Model by its OEM PID: one without is not a NaaS Model.
 *
 * This module names those fields and builds the encoded queries that keep a read to them; nothing else should spell
 * the fleet condition out.
 */

/** The alm_hardware boolean that marks a fleet asset. */
export const FLEET_FIELD = 'x_daas_ham_fleet'

/**
 * Encoded condition matching fleet assets only, on alm_hardware itself. A constant, like the two NaaS conditions below,
 * because Fluent metadata reads constants only: its reference qualifiers, list filters and dashboard queries import it.
 */
export const FLEET_CONDITION = `${FLEET_FIELD}=true`

/** The same as a script condition on `current`, an Asset: what a business rule's or UI action's condition tests. */
export const CURRENT_IS_FLEET = `current.${FLEET_FIELD} == true`

/** Encoded condition matching fleet assets only (through `via` from another table, e.g. `asset.`). */
export function fleetCondition(via = ''): string {
    return `${via}${FLEET_CONDITION}`
}

/**
 * Encoded condition matching assets outside the fleet: false, and blank too (a row from before the column), which is
 * not left to how `!=` treats an empty value.
 */
export function outsideFleetCondition(via = ''): string {
    const flag = `${via}${FLEET_FIELD}`
    return `${flag}=false^OR${flag}ISEMPTY`
}

/**
 * `query` kept to fleet assets: the fleet condition is ANDed into every top-level `^NQ` clause, as a condition
 * appended after `^NQ` would bind to the last clause only. An empty query becomes the fleet condition alone.
 */
export function inFleet(query: string, via = ''): string {
    return andEachClause(query, fleetCondition(via))
}

/**
 * Fleet assets in any of `stages` (domain/lifecycle `stagesQuery`, with `base` and `via` as there): every stage's
 * clause carries the fleet condition.
 */
export function fleetStagesQuery(stages: readonly Stage[], base = '', via = ''): string {
    return inFleet(stagesQuery(stages, base, via), via)
}

/**
 * Fleet assets in one stage, as `fleetStagesQuery([stage])` gives them: the constants Fluent metadata imports for its
 * lists, modules and dashboard tiles (domain/fleet.test.ts holds each to the function's result).
 */
export const FLEET_IN_STAGE = {
    in_service: `install_status=${STAGE_FIELDS.in_service.installStatus}^substatusISEMPTY^${FLEET_CONDITION}`,
    pending_in_service: `install_status=${STAGE_FIELDS.pending_in_service.installStatus}^substatus=${STAGE_FIELDS.pending_in_service.substatus}^${FLEET_CONDITION}`,
    available: `install_status=${STAGE_FIELDS.available.installStatus}^substatus=${STAGE_FIELDS.available.substatus}^${FLEET_CONDITION}`,
    spare_pool: `install_status=${STAGE_FIELDS.spare_pool.installStatus}^substatus=${STAGE_FIELDS.spare_pool.substatus}^${FLEET_CONDITION}`,
    in_transit: `install_status=${STAGE_FIELDS.in_transit.installStatus}^substatusISEMPTY^${FLEET_CONDITION}`,
} as const

/**
 * Encoded condition on alm_hardware: installed at a Site, which is In use by install status, whatever the substatus.
 * Every query about installed fleet assets starts from it.
 */
export const INSTALLED_CONDITION = `install_status=${INSTALL_STATUS.inUse}`

/** Fleet assets In use by install status: installed at a Site, whatever their substatus. */
export const FLEET_INSTALLED = `${INSTALLED_CONDITION}^${FLEET_CONDITION}`

/** The Stockroom field that holds its type (alm_stockroom.x_daas_ham_stockroom_type). */
export const STOCKROOM_TYPE_FIELD = 'x_daas_ham_stockroom_type'

/** The types of NaaS stockrooms: every type there is. A stockroom with no type (or another) is the Provider IT's, not NaaS. */
export const NAAS_STOCKROOM_TYPES: readonly StockroomType[] = Object.values(STOCKROOM_TYPE)

/** Encoded condition matching NaaS stockrooms, on alm_stockroom itself (domain/fleet.test.ts holds it to the list above). */
export const NAAS_STOCKROOM_CONDITION = `${STOCKROOM_TYPE_FIELD}IN${STOCKROOM_TYPE.central_depot},${STOCKROOM_TYPE.staging_centre},${STOCKROOM_TYPE.customer_site}`

/** The same as a script condition on `current`, a Stockroom (domain/fleet.test.ts holds it to the list above too). */
export const CURRENT_IS_NAAS_STOCKROOM = `current.${STOCKROOM_TYPE_FIELD} == '${STOCKROOM_TYPE.central_depot}' || current.${STOCKROOM_TYPE_FIELD} == '${STOCKROOM_TYPE.staging_centre}' || current.${STOCKROOM_TYPE_FIELD} == '${STOCKROOM_TYPE.customer_site}'`

/** The NaaS stockroom type `value` (a stored type) names, or null for a stockroom outside NaaS. */
export function naasStockroomType(value: string): StockroomType | null {
    return NAAS_STOCKROOM_TYPES.find((type) => type === value) ?? null
}

/** Encoded condition matching NaaS stockrooms (through `via`, e.g. `stockroom.` from an Asset). */
export function naasStockroomCondition(via = ''): string {
    return `${via}${NAAS_STOCKROOM_CONDITION}`
}

/**
 * Encoded condition matching stockrooms outside NaaS (through `via`, e.g. `from_stockroom.`): another type, or none,
 * which is not left to how `NOT IN` treats an empty value. The complement of `naasStockroomCondition`.
 */
export function outsideNaasStockroomCondition(via = ''): string {
    const type = `${via}${STOCKROOM_TYPE_FIELD}`
    return `${type}NOT IN${NAAS_STOCKROOM_TYPES.join(',')}^OR${type}ISEMPTY`
}

/**
 * The Provider's own NaaS stockrooms, by type: its central depots and staging centres, which hold its free stock and
 * the Spare pools and take in arriving units. The one other NaaS type, a customer-site stockroom, holds that Customer's
 * site stock at a Site.
 */
export const PROVIDER_STOCKROOM_TYPES: readonly StockroomType[] = [STOCKROOM_TYPE.central_depot, STOCKROOM_TYPE.staging_centre]

/** Encoded condition matching the Provider's own NaaS stockrooms (through `via`, e.g. `stockroom.` from an Asset). */
export function providerStockroomCondition(via = ''): string {
    return `${via}${STOCKROOM_TYPE_FIELD}IN${PROVIDER_STOCKROOM_TYPES.join(',')}`
}

/** The Model field that holds its OEM PID (cmdb_model.x_daas_ham_oem_pid). */
export const OEM_PID_FIELD = 'x_daas_ham_oem_pid'

/** Encoded condition matching NaaS Models, on cmdb_model itself. */
export const NAAS_MODEL_CONDITION = `${OEM_PID_FIELD}ISNOTEMPTY`

/**
 * The platform's `lifecycle_type` of a milestone a manufacturer publishes (cmdb_model_lifecycle, ADR 0017); the other,
 * Internal, is an organisation's own plan for a Model.
 */
export const PUBLISHER_LIFECYCLE_TYPE = 'publisher'

/**
 * Encoded query on cmdb_model_lifecycle: the milestones the manufacturers publish for NaaS Models, by Model and date
 * (ADR 0017: the table holds the milestones of the Provider IT's Models too).
 */
export const NAAS_MODEL_MILESTONES = `model.${NAAS_MODEL_CONDITION}^lifecycle_type=${PUBLISHER_LIFECYCLE_TYPE}^ORDERBYmodel^ORDERBYstart_date`

/** Whether a Model with this OEM PID is a NaaS Model: it has one. */
export function isNaasModel(oemPid: string): boolean {
    return oemPid.trim() !== ''
}

/** Encoded condition matching NaaS Models (through `via`, e.g. `model.` from an Asset). */
export function naasModelCondition(via = ''): string {
    return `${via}${NAAS_MODEL_CONDITION}`
}

/**
 * The Location field that marks a customer Site (cmn_location.x_daas_ham_is_site): what tells a Site from the Provider
 * IT's locations on the shared table.
 */
export const SITE_FIELD = 'x_daas_ham_is_site'

/** Encoded condition matching customer Sites, on cmn_location itself. */
export const SITE_CONDITION = `${SITE_FIELD}=true`

/** A Customer's Sites, once the Customer's sys_id is appended: what a Site picker's qualifier completes. */
export const SITES_OF_CUSTOMER_QUERY = `${SITE_CONDITION}^company=`

/** An Asset as adoption into the fleet (or a receipt taking it in) judges it. */
export interface FleetCandidate {
    fleet: boolean
    stage: Stage | null
    /** The OEM PID of its Model ('' when the Model has none). */
    modelPid: string
    /** The type of the Stockroom it is in, as stored ('' for none, or a stockroom with no type). */
    stockroomType: string
    hasSite: boolean
    hasAgreement: boolean
}

/**
 * Stages an Asset outside the fleet may join it in: on its way, free stock, or in service. Any other stage holds
 * context the app sets as it goes (an Order line, a Spare pool, a Staging task, a return, a disposal) that a unit
 * adopted from outside does not carry.
 */
const ADOPTABLE_STAGES: readonly Stage[] = ['on_order', 'in_transit', 'available', 'in_service']

/** Why an Asset is not added to the fleet by "Add to fleet", or null when it can be. */
export function adoptionProblem(unit: FleetCandidate): string | null {
    if (unit.fleet) return 'it is already a fleet asset'
    if (!isNaasModel(unit.modelPid)) return 'its Model has no OEM PID: give the Model its OEM PID first'
    if (unit.stage === null || !ADOPTABLE_STAGES.includes(unit.stage)) {
        const stage = unit.stage ?? 'a stage NaaS does not model'
        return `only an asset on order, in transit, available or in service joins the fleet (this one is ${stage})`
    }
    if (unit.stage === 'available' && !naasStockroomType(unit.stockroomType)) {
        return 'put it in a NaaS stockroom (one with a stockroom type) first'
    }
    if (unit.stage === 'in_service' && !(unit.hasSite && unit.hasAgreement)) {
        return 'an asset in service joins the fleet with its Site and Agreement: set them first'
    }
    return null
}

/**
 * Why a receipt does not take in this Asset, as far as the fleet goes, or null when it does. A fleet asset is received
 * as usual. One outside the fleet that awaits receipt (Procurement creates the units of a purchase order on order)
 * joins the fleet as it is received, when adoption allows it. Any other is the Provider IT's equipment, which a
 * receipt leaves alone.
 */
export function receiptProblem(unit: FleetCandidate, awaitingReceipt: boolean): string | null {
    if (unit.fleet) return null
    if (!awaitingReceipt) return 'it is not a fleet asset: an asset manager adds it to the fleet first'
    return adoptionProblem(unit)
}
