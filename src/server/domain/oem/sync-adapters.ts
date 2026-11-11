import { chunks } from '../collections.ts'
import { failureText, isSuccess, type HttpPort } from '../http.ts'
import { asArray, field, isoDate, parseJson, text } from '../json.ts'
import type { CoverageFact, CoverageFetched, Fetched, LifecycleFact, RmaFact } from './types.ts'
import { fortiCloudError } from './forticloud.ts'
import { REST_MESSAGE } from '../rest-message-names.ts'

/*
 * The vendor adapters the sync jobs call for lifecycle, coverage and RMA status (ADR 0008). Response shapes follow the vendors' public API documentation; mappers
 * read tolerantly so optional or renamed fields degrade to "unknown" rather than failing.
 */

export interface OemContext {
    http: HttpPort
    /** Organisations to search (Meraki, Mist); unused by vendors with global lookups. */
    orgIds: readonly string[]
}

export type Capability<Result> = (keys: readonly string[], context: OemContext) => Result

function call(context: OemContext, fn: string, params: Record<string, string>, errors: string[]): unknown {
    const response = context.http({ fn, params })
    if (!isSuccess(response.status)) {
        errors.push(`${fn} ${JSON.stringify(params)}: ${failureText(response)}`)
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

/**
 * A PID as compared with another, trimmed and in upper case, as the OEMs write it: Cisco answers in its own case
 * (WS-C3850-24T for ws-c3850-24t asked), and Models are matched to an OEM's answer by it.
 */
export function pidKey(pid: string): string {
    return pid.trim().toUpperCase()
}

/**
 * The PID of `batch` an EoX record answers, as it was sent: its input value (`EOXInputValue`), else its product
 * (`EOLProductID`), matched ignoring case; undefined when it answers none of them.
 */
function askedPid(record: unknown, batch: readonly string[]): string | undefined {
    for (const answered of [text(field(record, 'EOXInputValue')), text(field(record, 'EOLProductID'))]) {
        const pid = answered ? batch.find((asked) => pidKey(asked) === pidKey(answered)) : undefined
        if (pid !== undefined) return pid
    }
    return undefined
}

/** EoX v5 by PID: each fact carries the PID as it was asked, so the caller finds its Model whatever case Cisco answers in. */
export const ciscoLifecycle: Capability<Fetched<LifecycleFact>> = (pids, context) => {
    const facts: LifecycleFact[] = []
    const errors: string[] = []
    for (const batch of eoxBatches(pids)) {
        const json = call(context, REST_MESSAGE.ciscoSupport.fn.eoxByPid, { pids: batch.join(',') }, errors)
        for (const record of asArray(field(json, 'EOXRecord'))) {
            if (field(record, 'EOXError')) continue // product without an EoX bulletin
            const product = text(field(record, 'EOLProductID'))
            if (!product) continue
            const pid = askedPid(record, batch)
            if (pid === undefined) {
                errors.push(`eox_by_pid: the EoX record of ${product} answers none of the product IDs asked`)
                continue
            }
            const lastDateOfSupport = isoDate(field(record, 'LastDateOfSupport', 'value'))
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

export const ciscoCoverage: Capability<CoverageFetched> = (serials, context) => {
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
            // YES or NO; a record without it says nothing about the contract, which keeps what is stored.
            const isCovered = text(field(record, 'is_covered')).toUpperCase()
            if (isCovered !== 'YES' && isCovered !== 'NO') {
                errors.push(`coverage_by_serial ${serial}: no is_covered in the answer, so its stored coverage is kept`)
                continue
            }
            facts.push({
                serial,
                covered: isCovered === 'YES',
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

export const ciscoRmaStatus: Capability<Fetched<RmaFact>> = (rmaNumbers, context) => {
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

/** Whether a Meraki inventory device carries EoX dates: its `eox` may be there with a null status and no dates. */
function hasEoxDates(device: unknown): boolean {
    return !!(isoDate(field(device, 'eox', 'endOfSaleAt')) || isoDate(field(device, 'eox', 'endOfSupportAt')))
}

/** The first organisation whose inventory has a device of the model with EoX dates gives them; later ones are not asked. */
export const merakiLifecycle: Capability<Fetched<LifecycleFact>> = (pids, context) => {
    const facts: LifecycleFact[] = []
    const errors: string[] = []
    for (const pid of pids) {
        for (const orgId of context.orgIds) {
            const json = call(context, REST_MESSAGE.meraki.fn.inventoryByModel, { org_id: orgId, model: merakiModel(pid) }, errors)
            const device = asArray(json).find(hasEoxDates)
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

function fortinetContract(asset: unknown, end: string | undefined): unknown {
    const contracts = asArray(field(asset, 'contracts'))
    const matching = contracts.find((c) => end !== undefined && asArray(field(c, 'terms')).some((t) => isoDate(field(t, 'endDate')) === end))
    return matching ?? contracts[0]
}

export const fortinetCoverage: Capability<CoverageFetched> = (serials, context) => {
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

type MistLookup = typeof REST_MESSAGE.mist.fn.jsiByModel | typeof REST_MESSAGE.mist.fn.jsiBySerial

/**
 * The first org's matching JSI items. `answered` is true when items were found, or every org answered
 * that it has none; if any org's call failed and nothing was found, the device may be in that org.
 */
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

export const mistLifecycle: Capability<Fetched<LifecycleFact>> = (pids, context) => {
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

export const mistCoverage: Capability<CoverageFetched> = (serials, context) => {
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
