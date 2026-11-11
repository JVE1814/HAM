import type { Stage } from './lifecycle.ts'
import type { PowerBudget } from './rack.ts'
import type { AttestationResponse, LifecyclePhase, RackFace, ReturnMethod } from './vocabulary.ts'

/**
 * What the REST resources of the three pages take and answer (src/fluent/shared/rest-api.now.ts): each shape is declared
 * here once, for the page that sends or reads it and the entry adapter or platform service that reads or builds it. Types only, so the
 * module adds no code to either. A request body is what a page sends; the server still checks what it receives.
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

/** POST /receive: the scanned code, the Stockroom received into and, for a unit no ASN announced, its PID. */
export interface ReceiveRequest {
    code: string
    stockroom: string
    pid?: string
}

/** POST /putaway: the scanned code and the Stockroom the unit now sits in. */
export interface PutAwayRequest {
    code: string
    stockroom: string
}

/** POST /pick: the scanned code and the number of the Order it is picked for. */
export interface PickRequest {
    code: string
    order: string
}

/** POST /audits/{id}/scan: the scanned code. */
export interface AuditScanRequest {
    code: string
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

/** POST /customer/faults: the Asset reported faulty (its sys_id) and what is wrong with it. */
export interface FaultRequest {
    asset: string
    description: string
}

/** POST /customer/faults: the number of the case opened. */
export interface FaultReport {
    case: string
}

/** POST /customer/orders/{id}/installed: the Order's number. */
export interface InstallConfirmation {
    order: string
}

/** POST /customer/attestations/{id}: the answers given so far, and whether the Attestation is submitted with them. */
export interface AttestationAnswers {
    items: Array<Pick<AttestationItem, 'id' | 'response'>>
    submit: boolean
}

/** POST /customer/attestations/{id}: the Attestation's number. */
export interface AttestationReceipt {
    attestation: string
}

/** POST /customer/returns: the Site, the devices listed (sys_ids), whether it is the whole Site, and how they come back. */
export interface ReturnRequestBody {
    site: string
    assets: string[]
    decommission: boolean
    method: ReturnMethod
}

/** POST /customer/returns: the number of the Return order raised. */
export interface ReturnRequestReceipt {
    returnOrder: string
}
