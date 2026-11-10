import { chunks } from '../collections.ts'
import { errorText, isSuccess, type HttpPort } from '../http.ts'
import { asArray, field, isoDate, parseJson, text } from '../json.ts'
import type { OemVendor } from '../vocabulary.ts'
import type { CoverageFact, CoverageFetched, Fetched, LifecycleFact, RmaFact } from './types.ts'
import { fortiCloudError } from './forticloud.ts'
import { REST_MESSAGE, type RestFunction } from '../rest-message-names.ts'

/*
 * Vendor adapters (ADR 0008). Response shapes follow the vendors' public API documentation; mappers
 * read tolerantly so optional or renamed fields degrade to "unknown" rather than failing.
 * Request functions name the REST message functions declared in fluent/logic/oem-messages.now.ts.
 */

export interface OemContext {
    http: HttpPort
    /** Organisations to search (Meraki, Mist); unused by vendors with global lookups. */
    orgIds: readonly string[]
}

type Capability<Result> = (keys: readonly string[], context: OemContext) => Result

function call(context: OemContext, fn: RestFunction, params: Record<string, string>, errors: string[]): unknown {
    const response = context.http({ fn, params })
    if (!isSuccess(response.status)) {
        errors.push(`${fn} ${JSON.stringify(params)}: ${errorText(response.status, response.body)}`)
        return undefined
    }
    const json = parseJson(response.body)
    if (json === undefined) errors.push(`${fn}: response is not JSON`)
    return json
}

// --- Cisco Support APIs (EoX v5, SN2INFO v2, Service Order Return) ---------------------------

/** EoX v5 takes up to 20 PIDs per call, and the comma-joined productID is limited to 250 characters. */
function eoxBatches(pids: readonly string[]): string[][] {
    const out: string[][] = []
    let batch: string[] = []
    for (const pid of pids) {
        if (batch.length === 20 || (batch.length > 0 && [...batch, pid].join(',').length > 250)) {
            out.push(batch)
            batch = []
        }
        batch.push(pid)
    }
    if (batch.length > 0) out.push(batch)
    return out
}

const ciscoLifecycle: Capability<Fetched<LifecycleFact>> = (pids, context) => {
    const facts: LifecycleFact[] = []
    const errors: string[] = []
    for (const batch of eoxBatches(pids)) {
        const json = call(context, REST_MESSAGE.ciscoSupport.fn.eoxByPid, { pids: batch.join(',') }, errors)
        for (const record of asArray(field(json, 'EOXRecord'))) {
            if (field(record, 'EOXError')) continue // product without an EoX bulletin
            const pid = text(field(record, 'EOLProductID'))
            const lastDateOfSupport = isoDate(field(record, 'LastDateOfSupport', 'value'))
            if (!pid) continue
            facts.push({
                pid,
                dates: {
                    endOfSale: isoDate(field(record, 'EndOfSaleDate', 'value')),
                    endOfSupport: lastDateOfSupport,
                    endOfLife: lastDateOfSupport,
                },
                reference: text(field(record, 'LinkToProductBulletinURL')),
            })
        }
    }
    return { facts, errors }
}

const ciscoCoverage: Capability<CoverageFetched> = (serials, context) => {
    const facts: CoverageFact[] = []
    const errors: string[] = []
    const failed: string[] = []
    const rejected: string[] = []
    for (const batch of chunks(serials, 50)) {
        const json = call(context, REST_MESSAGE.ciscoSupport.fn.coverageBySerial, { serials: batch.join(',') }, errors)
        // A failed call says nothing about the batch (asked again next run). An answer without
        // serial_numbers is Cisco's own error (e.g. EXCEEDED_OUTPUT): asked again only after the
        // refresh interval, so a batch that always errors does not hold the queue.
        if (json === undefined) {
            failed.push(...batch)
            continue
        }
        const records = field(json, 'serial_numbers')
        if (!Array.isArray(records)) {
            errors.push(`coverage_by_serial: no serial_numbers in the response`)
            rejected.push(...batch)
            continue
        }
        for (const record of records as unknown[]) {
            const serial = text(field(record, 'sr_no'))
            if (!serial) continue
            facts.push({
                serial,
                covered: text(field(record, 'is_covered')).toUpperCase() === 'YES',
                contractNumber: text(field(record, 'service_contract_number')),
                serviceLevel: text(field(record, 'service_line_descr')),
                // The SN2INFO v2 summary has no start date; v1.0 responses carry coverage_start_date.
                startDate: isoDate(field(record, 'coverage_start_date')),
                // Contract end (v2 summary), then the v1.0 name, then the warranty end.
                endDate:
                    isoDate(field(record, 'covered_product_line_end_date')) ??
                    isoDate(field(record, 'coverage_end_date')) ??
                    isoDate(field(record, 'warranty_end_date')),
            })
        }
    }
    return { facts, errors, failed, rejected }
}

const ciscoRmaStatus: Capability<Fetched<RmaFact>> = (rmaNumbers, context) => {
    const facts: RmaFact[] = []
    const errors: string[] = []
    for (const rma of rmaNumbers) {
        const json = call(context, REST_MESSAGE.ciscoSupport.fn.rmaStatus, { rma }, errors)
        for (const record of asArray(field(json, 'returns', 'RmaRecord'))) {
            const rmaNumber = text(field(record, 'rmaNo')) || rma
            const status = text(field(record, 'status'))
            if (status) facts.push({ rmaNumber, status })
        }
    }
    return { facts, errors }
}

// --- Cisco Meraki Dashboard API (inventory with eox) ----------------------------------------

/** Meraki ordering SKUs end in -HW; the dashboard reports the bare model. */
function merakiModel(pid: string): string {
    return pid.replace(/-HW$/i, '')
}

const merakiLifecycle: Capability<Fetched<LifecycleFact>> = (pids, context) => {
    const facts: LifecycleFact[] = []
    const errors: string[] = []
    for (const pid of pids) {
        for (const orgId of context.orgIds) {
            const json = call(context, REST_MESSAGE.meraki.fn.inventoryByModel, { org_id: orgId, model: merakiModel(pid) }, errors)
            const device = asArray(json).find((d) => field(d, 'eox'))
            if (!device) continue
            facts.push({
                pid,
                dates: {
                    endOfSale: isoDate(field(device, 'eox', 'endOfSaleAt')),
                    endOfSupport: isoDate(field(device, 'eox', 'endOfSupportAt')),
                },
                reference: `meraki:${orgId}`,
            })
            break
        }
    }
    return { facts, errors }
}

// --- Fortinet Asset Management API v3 --------------------------------------------------------

/** The asset's contract that has a term ending on the given date, else its first contract. */
function fortinetContract(asset: unknown, end: string | undefined): unknown {
    const contracts = asArray(field(asset, 'contracts'))
    const matching = contracts.find((c) => end !== undefined && asArray(field(c, 'terms')).some((t) => isoDate(field(t, 'endDate')) === end))
    return matching ?? contracts[0]
}

const fortinetCoverage: Capability<CoverageFetched> = (serials, context) => {
    const facts: CoverageFact[] = []
    const errors: string[] = []
    const failed: string[] = []
    const rejected: string[] = []
    for (const serial of serials) {
        const json = call(context, REST_MESSAGE.fortiCare.fn.productsList, { serial }, errors)
        if (json === undefined) {
            failed.push(serial)
            continue
        }
        // An API error in FortiCloud's HTTP 200 envelope (e.g. a unit not in the account) is an
        // answer: the serial keeps its coverage and is asked again only after the refresh interval,
        // so permanent rejections do not hold the rate-limited queue.
        const error = fortiCloudError(json)
        if (error) {
            errors.push(`products_list ${serial}: ${error}`)
            rejected.push(serial)
            continue
        }
        for (const asset of asArray(field(json, 'assets'))) {
            const entitlements = asArray(field(asset, 'entitlements'))
                .map((e) => ({
                    level: text(field(e, 'levelDesc')) || text(field(e, 'typeDesc')),
                    start: isoDate(field(e, 'startDate')),
                    end: isoDate(field(e, 'endDate')),
                }))
                .filter((e) => e.end)
                .sort((a, b) => (b.end ?? '').localeCompare(a.end ?? ''))
            const latest = entitlements[0]
            facts.push({
                serial: text(field(asset, 'serialNumber')) || serial,
                covered: !!latest,
                contractNumber: text(field(fortinetContract(asset, latest?.end), 'contractNumber')),
                serviceLevel: latest?.level ?? '',
                startDate: latest?.start,
                endDate: latest?.end,
            })
        }
    }
    return { facts, errors, failed, rejected }
}

// --- HPE Mist (JSI inventory) ----------------------------------------------------------------

/**
 * The first org's matching JSI items. `answered` is true when items were found, or every org answered
 * that it has none; if any org's call failed and nothing was found, the device may be in that org.
 */
type MistLookup = typeof REST_MESSAGE.mist.fn.jsiByModel | typeof REST_MESSAGE.mist.fn.jsiBySerial

function mistLookup(context: OemContext, fn: MistLookup, params: Record<string, string>, errors: string[]): { items: unknown[]; answered: boolean } {
    let anyFailed = false
    for (const orgId of context.orgIds) {
        const json = call(context, fn, { org_id: orgId, ...params }, errors)
        if (json === undefined) {
            anyFailed = true
            continue
        }
        const items = asArray(json)
        if (items.length > 0) return { items, answered: true }
    }
    return { items: [], answered: !anyFailed }
}

const mistLifecycle: Capability<Fetched<LifecycleFact>> = (pids, context) => {
    const facts: LifecycleFact[] = []
    const errors: string[] = []
    for (const pid of pids) {
        // JSI: end_of_sale_time is end of sale, eos_time is end of support (epoch seconds).
        const item = mistLookup(context, REST_MESSAGE.mist.fn.jsiByModel, { model: pid }, errors).items.find((i) => field(i, 'end_of_sale_time') || field(i, 'eos_time'))
        if (!item) continue
        facts.push({
            pid,
            dates: { endOfSale: isoDate(field(item, 'end_of_sale_time')), endOfSupport: isoDate(field(item, 'eos_time')) },
            reference: 'mist:jsi',
        })
    }
    return { facts, errors }
}

const mistCoverage: Capability<CoverageFetched> = (serials, context) => {
    const facts: CoverageFact[] = []
    const errors: string[] = []
    const failed: string[] = []
    for (const serial of serials) {
        const { items, answered } = mistLookup(context, REST_MESSAGE.mist.fn.jsiBySerial, { serial }, errors)
        if (!answered) failed.push(serial)
        const item = items[0]
        if (!item) continue
        // JSI dates are YYYY-MM-DD strings; has_support means an active support contract.
        const end = isoDate(field(item, 'warranty_end')) ?? isoDate(field(item, 'contract_end_date'))
        facts.push({
            serial,
            covered: field(item, 'has_support') === true || !!end,
            contractNumber: text(field(item, 'contract_id')),
            serviceLevel: text(field(item, 'warranty_type')) || text(field(item, 'contract_type')),
            startDate: isoDate(field(item, 'warranty_start')) ?? isoDate(field(item, 'contract_start_date')),
            endDate: end,
        })
    }
    return { facts, errors, failed, rejected: [] }
}

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

/** A vendor whose turn it is in a sync job, with the route the job runs for it. */
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
