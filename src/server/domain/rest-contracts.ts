import type { Stage } from './lifecycle.ts'
import type { PowerBudget } from './rack.ts'
import type { AttestationResponse, LifecyclePhase, RackFace } from './vocabulary.ts'

/**
 * What the REST resources of the three pages answer (src/fluent/logic/rest.now.ts): each shape is declared here once,
 * for the entry function that builds it and the page that reads it. Types only, so the module adds no code to either.
 */

/** A fleet asset's Lifecycle stage; `unknown` when its install status and substatus are no stage of the app's. */
export type AssetStage = Stage | 'unknown'

/** The unit a warehouse scan found or changed: GET /assets/{code}, POST /receive, /putaway and /pick. */
export interface AssetSummary {
    id: string
    serial: string
    providerTag: string
    model: string
    pid: string
    stage: AssetStage
    stockroom: string
    customer: string
    orderLine: string
}

export interface Stockroom {
    id: string
    name: string
}

/** GET /stockrooms */
export interface StockroomList {
    stockrooms: Stockroom[]
}

export interface Site {
    id: string
    name: string
    customer: string
}

/** GET /sites */
export interface SiteList {
    sites: Site[]
}

export interface RackListing {
    id: string
    name: string
    room: string
}

/** GET /racks?site={sys_id} */
export interface RackList {
    racks: RackListing[]
}

export interface RackDevice {
    id: string
    tag: string
    serial: string
    stage: AssetStage
    /** Blank when the Asset has no Lifecycle phase recorded. */
    lifecyclePhase: LifecyclePhase | ''
    coverageEnd: string
    refreshDue: string
    customer: string
    model: string
    ruStart: number
    height: number
    face: RackFace
}

/** GET /racks/{id} */
export interface RackElevation {
    rack: { id: string; name: string; units: number; power: PowerBudget }
    devices: RackDevice[]
}

export interface CustomerAsset {
    id: string
    serial: string
    customerTag: string
    model: string
    site: string
    siteId: string
    stage: AssetStage
    refreshDue: string
}

export interface CustomerOrder {
    id: string
    number: string
    type: string
    site: string
    stageLabel: string
    canConfirmInstall: boolean
}

export interface CustomerReturn {
    number: string
    site: string
    trigger: string
    dueDate: string
    /** Blank, with the tracking number, while the Return order has no prepaid label in use. */
    labelUrl: string
    trackingNumber: string
}


export interface AttestationItem {
    id: string
    serial: string
    model: string
    /** Blank until answered. */
    response: AttestationResponse | ''
}

export interface Attestation {
    id: string
    number: string
    site: string
    items: AttestationItem[]
}

/** GET /customer/overview */
export interface CustomerOverview {
    customer: string
    isCustomerAdmin: boolean
    assets: CustomerAsset[]
    orders: CustomerOrder[]
    returns: CustomerReturn[]
    attestations: Attestation[]
}

/** POST /customer/faults: the number of the case opened. */
export interface FaultReport {
    case: string
}

/** POST /customer/orders/{id}/installed: the Order's number. */
export interface InstallConfirmation {
    order: string
}

/** POST /customer/attestations/{id}: the Attestation's number. */
export interface AttestationReceipt {
    attestation: string
}

/** POST /customer/returns: the number of the Return order raised. */
export interface ReturnRequestReceipt {
    returnOrder: string
}
