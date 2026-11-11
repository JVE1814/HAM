import type { ClaimAction, OemVendor } from '../vocabulary.ts'
import type { CoverageFetched, Fetched, LifecycleFact, RmaFact } from './types.ts'
import { REST_MESSAGE } from '../rest-message-names.ts'
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

/**
 * The REST message that serves each vendor's lifecycle, coverage and RMA calls: the vendors whose API the sync jobs
 * read (`SyncVendor`). Only these may have routes below, a route names one of them as its `via`, and platform/oem-http
 * must hold the enabled property of each: a vendor given a route without its message or its switch does not compile.
 */
export const SYNC_MESSAGE = {
    cisco: REST_MESSAGE.ciscoSupport.name,
    meraki: REST_MESSAGE.meraki.name,
    fortinet: REST_MESSAGE.fortiCare.name,
    mist: REST_MESSAGE.mist.name,
} as const satisfies Partial<Record<OemVendor, string>>

export type SyncVendor = keyof typeof SYNC_MESSAGE

export function isSyncVendor(vendor: OemVendor): vendor is SyncVendor {
    return vendor in SYNC_MESSAGE
}

interface Route<Result> {
    /** Vendor whose REST message serves the call (Meraki hardware coverage comes from Cisco SN2INFO). */
    via: SyncVendor
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

type NoRoutes = { [K in keyof VendorRoutes]?: never }

/** What each vendor's API can do; missing capabilities fall back to CSV import. A vendor outside SYNC_MESSAGE has none. */
export const OEM_ADAPTERS: { [V in OemVendor]: V extends SyncVendor ? VendorRoutes : NoRoutes } = {
    cisco: {
        lifecycle: { via: 'cisco', run: ciscoLifecycle },
        coverage: { via: 'cisco', run: ciscoCoverage },
        rmaStatus: { via: 'cisco', run: ciscoRmaStatus },
    },
    meraki: { lifecycle: { via: 'meraki', run: merakiLifecycle }, coverage: { via: 'cisco', run: ciscoCoverage } },
    fortinet: {
        // FortiCloud allows 100 calls per minute and 1000 per hour, and products/list takes one serial
        // per call: at most 90 serials per run (every 4 hours).
        coverage: { via: 'fortinet', run: fortinetCoverage, maxKeysPerRun: 90 },
    },
    mist: { lifecycle: { via: 'mist', run: mistLifecycle }, coverage: { via: 'mist', run: mistCoverage } },
    aruba: {},
    checkpoint: {},
}

/**
 * The order the sync jobs take the vendors in. It is an order, not the list of vendors, which is `OemVendor`: the type
 * below fails when a vendor is missing from it.
 */
export const SYNC_ORDER = ['cisco', 'meraki', 'fortinet', 'mist', 'aruba', 'checkpoint'] as const satisfies readonly OemVendor[]

type Holds<T extends true> = T
type _EveryVendorHasItsTurn = Holds<[OemVendor] extends [(typeof SYNC_ORDER)[number]] ? true : false>

/**
 * `vendor`'s route for `capability` when it may run: `vendor` is enabled and so is the vendor whose REST message
 * serves the call. Meraki coverage therefore needs Cisco enabled too, and with Meraki off no Meraki serial goes to
 * Cisco SN2INFO.
 */
export function enabledRoute<K extends keyof VendorRoutes>(
    vendor: OemVendor,
    capability: K,
    enabled: (vendor: OemVendor) => boolean,
): VendorRoutes[K] | undefined {
    const route = OEM_ADAPTERS[vendor][capability]
    return route && enabled(vendor) && enabled(route.via) ? route : undefined
}

export interface SyncTurn<K extends keyof VendorRoutes> {
    vendor: OemVendor
    route: NonNullable<VendorRoutes[K]>
}

/** The vendors a sync job of `capability` calls, in SYNC_ORDER: those whose route may run (enabledRoute). */
export function enabledRoutes<K extends keyof VendorRoutes>(capability: K, enabled: (vendor: OemVendor) => boolean): Array<SyncTurn<K>> {
    return SYNC_ORDER.flatMap((vendor) => {
        const route = enabledRoute(vendor, capability, enabled)
        return route ? [{ vendor, route }] : []
    })
}

/** Which vendor can do which staging step, through which claim adapter. Cisco PnP has no public API. */
const CLAIM_ROUTES: Partial<Record<OemVendor, VendorClaimRoutes>> = {
    meraki: { oem_claim: MERAKI_CLAIM },
    mist: { oem_claim: MIST_CLAIM },
    aruba: { oem_claim: GREENLAKE_ADD, oem_licence: GREENLAKE_SUBSCRIBE },
    fortinet: { oem_claim: FORTICLOUD_REGISTER, oem_ztp: FORTIZTP_PROVISION },
    checkpoint: { oem_ztp: ZERO_TOUCH_CLAIM },
}

export function claimRoutes(vendor: OemVendor): VendorClaimRoutes {
    return CLAIM_ROUTES[vendor] ?? {}
}

/** Whether a run can send `vendor` an `action` step: a template's step it cannot is copied as one done by hand. */
export function claimRouted(vendor: string, action: string): boolean {
    return Boolean(claimRoutes(vendor as OemVendor)[action as ClaimAction])
}

/** Vendors with at least one automated step (Cisco has none). */
export const CLAIM_VENDORS: readonly OemVendor[] = Object.keys(CLAIM_ROUTES) as OemVendor[]
