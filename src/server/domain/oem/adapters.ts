import { isIsoDate } from '../calendar.ts'
import { oneOf } from '../exhaustive.ts'
import { normalizeSerial } from '../serials.ts'
import type { ClaimAction, OemVendor } from '../vocabulary.ts'
import type { CoverageFact, CoverageFetched, Fetched, LifecycleFact, RmaFact } from './types.ts'
import { PROPERTY, type PropertyOf } from '../properties.ts'
import { REST_MESSAGE, type OemMessageName } from '../rest-message-names.ts'
import type { VendorClaimRoutes } from './claims.ts'
import { FORTICLOUD_REGISTER, FORTIZTP_PROVISION, GREENLAKE_ADD, GREENLAKE_SUBSCRIBE, MERAKI_CLAIM, MIST_CLAIM, ZERO_TOUCH_CLAIM } from './claim-adapters.ts'
import {
    ciscoCoverage,
    ciscoLifecycle,
    ciscoRmaStatus,
    fortinetCoverage,
    merakiLifecycle,
    mistCoverage,
    mistLifecycle,
    type Capability,
} from './sync-adapters.ts'

export interface SyncApi {
    message: OemMessageName
    enabled: PropertyOf<boolean>
    orgIds?: PropertyOf<string>
}

const CISCO_SUPPORT: SyncApi = { message: REST_MESSAGE.ciscoSupport.name, enabled: PROPERTY.oemEnabled.cisco }
const MERAKI_DASHBOARD: SyncApi = { message: REST_MESSAGE.meraki.name, enabled: PROPERTY.oemEnabled.meraki, orgIds: PROPERTY.oemOrgIds.meraki }
const FORTICLOUD: SyncApi = { message: REST_MESSAGE.fortiCare.name, enabled: PROPERTY.oemEnabled.fortinet }
const MIST: SyncApi = { message: REST_MESSAGE.mist.name, enabled: PROPERTY.oemEnabled.mist, orgIds: PROPERTY.oemOrgIds.mist }

interface Route<Result> {
    /** The API that serves the call: not always the vendor's own, as Meraki hardware coverage comes from Cisco SN2INFO. */
    api: SyncApi
    run: Capability<Result>
}

export interface CoverageRoute extends Route<CoverageFetched> {
    /** Serials asked per sync run, as one batch, for a rate-limited API; unset: batches until the job's time budget is spent. */
    maxKeysPerRun?: number
}

interface VendorRoutes {
    lifecycle?: Route<Fetched<LifecycleFact>>
    coverage?: CoverageRoute
    rmaStatus?: Route<Fetched<RmaFact>>
}

/** A vendor's own API, whose switch each of its routes needs on; a vendor without one has no routes. */
type SyncIntegration = ({ api: SyncApi } & VendorRoutes) | { api?: never; lifecycle?: never; coverage?: never; rmaStatus?: never }

interface ClaimIntegration {
    enabled: PropertyOf<boolean>
    routes: VendorClaimRoutes
}

type VendorIntegration = SyncIntegration & { claims?: ClaimIntegration }

/**
 * What each vendor's APIs can do: the capabilities the sync jobs read (missing ones fall back to CSV import) and the
 * staging steps the claim run sends (Cisco PnP has no public API). The claim run takes the vendors in this order.
 */
export const OEM_ADAPTERS: Record<OemVendor, VendorIntegration> = {
    cisco: {
        api: CISCO_SUPPORT,
        lifecycle: { api: CISCO_SUPPORT, run: ciscoLifecycle },
        coverage: { api: CISCO_SUPPORT, run: ciscoCoverage },
        rmaStatus: { api: CISCO_SUPPORT, run: ciscoRmaStatus },
    },
    meraki: {
        api: MERAKI_DASHBOARD,
        lifecycle: { api: MERAKI_DASHBOARD, run: merakiLifecycle },
        coverage: { api: CISCO_SUPPORT, run: ciscoCoverage },
        claims: { enabled: PROPERTY.claimEnabled.meraki, routes: { oem_claim: MERAKI_CLAIM } },
    },
    mist: {
        api: MIST,
        lifecycle: { api: MIST, run: mistLifecycle },
        coverage: { api: MIST, run: mistCoverage },
        claims: { enabled: PROPERTY.claimEnabled.mist, routes: { oem_claim: MIST_CLAIM } },
    },
    aruba: { claims: { enabled: PROPERTY.claimEnabled.aruba, routes: { oem_claim: GREENLAKE_ADD, oem_licence: GREENLAKE_SUBSCRIBE } } },
    fortinet: {
        api: FORTICLOUD,
        // FortiCloud allows 100 calls per minute and 1000 per hour, and products/list takes one serial
        // per call: at most 90 serials per run (every 4 hours).
        coverage: { api: FORTICLOUD, run: fortinetCoverage, maxKeysPerRun: 90 },
        claims: { enabled: PROPERTY.claimEnabled.fortinet, routes: { oem_claim: FORTICLOUD_REGISTER, oem_ztp: FORTIZTP_PROVISION } },
    },
    checkpoint: { claims: { enabled: PROPERTY.claimEnabled.checkpoint, routes: { oem_ztp: ZERO_TOUCH_CLAIM } } },
}

/**
 * The order the sync jobs take the vendors in, and the vendors a coverage CSV row may name (`parseCoverageRow`). The
 * type below fails when a vendor of `OemVendor` is missing from it.
 */
const SYNC_ORDER = ['cisco', 'meraki', 'fortinet', 'mist', 'aruba', 'checkpoint'] as const satisfies readonly OemVendor[]

type Holds<T extends true> = T
type _EveryVendorHasItsTurn = Holds<[OemVendor] extends [(typeof SYNC_ORDER)[number]] ? true : false>

/**
 * `vendor`'s route for `capability` when it may run: `vendor`'s own API is enabled and so is the API that serves the
 * call. Meraki coverage therefore needs Cisco enabled too, and with Meraki off no Meraki serial goes to Cisco SN2INFO.
 */
function enabledRoute<K extends keyof VendorRoutes>(vendor: OemVendor, capability: K, enabled: (api: SyncApi) => boolean): VendorRoutes[K] | undefined {
    const integration: VendorIntegration = OEM_ADAPTERS[vendor]
    const route = integration[capability]
    return route && integration.api && enabled(integration.api) && enabled(route.api) ? route : undefined
}

export interface SyncTurn<K extends keyof VendorRoutes> {
    vendor: OemVendor
    route: NonNullable<VendorRoutes[K]>
}

/** A coverage CSV row as loaded (vendors without an API), each column as text. */
interface CoverageRow {
    vendor: string
    serial: string
    contractNumber: string
    serviceLevel: string
    startDate: string
    endDate: string
    annualCost: string
}

type ParsedCoverageRow = { ok: true; vendor: OemVendor; fact: CoverageFact; annualCost?: number } | { ok: false; reason: string }

/** A coverage row's contract, which covers its serial over the dates it gives, or why the row is refused. */
export function parseCoverageRow(row: CoverageRow): ParsedCoverageRow {
    const vendor = oneOf(row.vendor, SYNC_ORDER)
    const serial = normalizeSerial(row.serial)
    const cost = row.annualCost.trim()
    const { startDate, endDate } = row
    if (!vendor) return { ok: false, reason: `vendor must be one of ${SYNC_ORDER.join(', ')}` }
    if (!serial) return { ok: false, reason: 'serial number is required' }
    if ((startDate && !isIsoDate(startDate)) || (endDate && !isIsoDate(endDate))) {
        return { ok: false, reason: 'dates must be real calendar dates (YYYY-MM-DD)' }
    }
    if (cost && !Number.isFinite(Number(cost))) return { ok: false, reason: 'annual cost must be a number' }
    const fact: CoverageFact = {
        serial,
        covered: true,
        contractNumber: row.contractNumber,
        serviceLevel: row.serviceLevel,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
    }
    return { ok: true, vendor, fact, annualCost: cost ? Number(cost) : undefined }
}

export function enabledRoutes<K extends keyof VendorRoutes>(capability: K, enabled: (api: SyncApi) => boolean): Array<SyncTurn<K>> {
    return SYNC_ORDER.flatMap((vendor) => {
        const route = enabledRoute(vendor, capability, enabled)
        return route ? [{ vendor, route }] : []
    })
}

export function claimRoutes(vendor: OemVendor): VendorClaimRoutes {
    return OEM_ADAPTERS[vendor].claims?.routes ?? {}
}

/** Whether a run can send `vendor` an `action` step: a template's step it cannot is copied as one done by hand. */
export function claimRouted(vendor: string, action: string): boolean {
    return Boolean(claimRoutes(vendor as OemVendor)[action as ClaimAction])
}

/** Vendors with at least one automated step, in the order the claim run takes them. */
export const CLAIM_VENDORS: readonly OemVendor[] = (Object.keys(OEM_ADAPTERS) as OemVendor[]).filter((vendor) => OEM_ADAPTERS[vendor].claims)

export interface ClaimTurn {
    vendor: OemVendor
    routes: VendorClaimRoutes
}

/** The vendors whose claim switch is on, with their routes, in the order the claim run takes them. */
export function enabledClaims(enabled: (property: PropertyOf<boolean>) => boolean): ClaimTurn[] {
    return CLAIM_VENDORS.flatMap((vendor) => {
        const claims = OEM_ADAPTERS[vendor].claims
        return claims && enabled(claims.enabled) ? [{ vendor, routes: claims.routes }] : []
    })
}
