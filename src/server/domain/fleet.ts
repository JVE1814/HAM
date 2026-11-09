import { andEachClause } from './encoded-query.ts'
import { stagesQuery, type Stage } from './lifecycle.ts'
import type { StockroomType } from './sourcing.ts'

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

/** The Fleet flag, dot-walked from another table through `via` (e.g. `asset.`, `x_daas_ham_failed_asset.`). */
export function fleetField(via = ''): string {
    return `${via}${FLEET_FIELD}`
}

/** Encoded condition matching fleet assets only (through `via` from another table). */
export function fleetCondition(via = ''): string {
    return `${fleetField(via)}=true`
}

/**
 * Encoded condition matching assets outside the fleet: false, and blank too (a row from before the column), which is
 * not left to how `!=` treats an empty value.
 */
export function outsideFleetCondition(via = ''): string {
    return `${fleetField(via)}=false^OR${fleetField(via)}ISEMPTY`
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

/** The Stockroom field that holds its type (alm_stockroom.x_daas_ham_stockroom_type). */
export const STOCKROOM_TYPE_FIELD = 'x_daas_ham_stockroom_type'

/** The types of NaaS stockrooms. A stockroom with no type (or another) is the Provider IT's, not NaaS. */
export const NAAS_STOCKROOM_TYPES: readonly StockroomType[] = ['central_depot', 'staging_centre', 'customer_site']

/** The NaaS stockroom type `value` (a stored type) names, or null for a stockroom outside NaaS. */
export function naasStockroomType(value: string): StockroomType | null {
    return NAAS_STOCKROOM_TYPES.find((type) => type === value) ?? null
}

/** Encoded condition matching NaaS stockrooms (through `via`, e.g. `stockroom.` from an Asset). */
export function naasStockroomCondition(via = ''): string {
    return `${via}${STOCKROOM_TYPE_FIELD}IN${NAAS_STOCKROOM_TYPES.join(',')}`
}

/** The Model field that holds its OEM PID (cmdb_model.x_daas_ham_oem_pid). */
export const OEM_PID_FIELD = 'x_daas_ham_oem_pid'

/** Whether a Model with this OEM PID is a NaaS Model: it has one. */
export function isNaasModel(oemPid: string): boolean {
    return oemPid.trim() !== ''
}

/** Encoded condition matching NaaS Models (through `via`, e.g. `model.` from an Asset). */
export function naasModelCondition(via = ''): string {
    return `${via}${OEM_PID_FIELD}ISNOTEMPTY`
}

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
