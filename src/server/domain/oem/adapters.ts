import { asArray, chunks, field, isoDate, parseJson, text } from '../json'
import type { CoverageFact, Fetched, HttpPort, LifecycleFact, OemVendor, RmaFact } from './types'

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

type Capability<T> = (keys: readonly string[], context: OemContext) => Fetched<T>

function call(context: OemContext, fn: string, params: Record<string, string>, errors: string[]): unknown {
    const response = context.http({ fn, params })
    if (response.status < 200 || response.status >= 300) {
        errors.push(`${fn} ${JSON.stringify(params)}: HTTP ${response.status}`)
        return undefined
    }
    const json = parseJson(response.body)
    if (json === undefined) errors.push(`${fn}: response is not JSON`)
    return json
}

// --- Cisco Support APIs (EoX v5, SN2INFO v2, Service Order Return) ---------------------------

const ciscoLifecycle: Capability<LifecycleFact> = (pids, context) => {
    const facts: LifecycleFact[] = []
    const errors: string[] = []
    for (const batch of chunks(pids, 20)) {
        const json = call(context, 'eox_by_pid', { pids: batch.join(',') }, errors)
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

const ciscoCoverage: Capability<CoverageFact> = (serials, context) => {
    const facts: CoverageFact[] = []
    const errors: string[] = []
    for (const batch of chunks(serials, 50)) {
        const json = call(context, 'coverage_by_serial', { serials: batch.join(',') }, errors)
        for (const record of asArray(field(json, 'serial_numbers'))) {
            const serial = text(field(record, 'sr_no'))
            if (!serial) continue
            facts.push({
                serial,
                covered: text(field(record, 'is_covered')).toUpperCase() === 'YES',
                contractNumber: text(field(record, 'service_contract_number')),
                serviceLevel: text(field(record, 'service_line_descr')),
                startDate: isoDate(field(record, 'coverage_start_date')),
                endDate: isoDate(field(record, 'coverage_end_date')) ?? isoDate(field(record, 'warranty_end_date')),
            })
        }
    }
    return { facts, errors }
}

const ciscoRmaStatus: Capability<RmaFact> = (rmaNumbers, context) => {
    const facts: RmaFact[] = []
    const errors: string[] = []
    for (const rma of rmaNumbers) {
        const json = call(context, 'rma_status', { rma }, errors)
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

const merakiLifecycle: Capability<LifecycleFact> = (pids, context) => {
    const facts: LifecycleFact[] = []
    const errors: string[] = []
    for (const pid of pids) {
        for (const orgId of context.orgIds) {
            const json = call(context, 'inventory_by_model', { org_id: orgId, model: merakiModel(pid) }, errors)
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

const fortinetCoverage: Capability<CoverageFact> = (serials, context) => {
    const facts: CoverageFact[] = []
    const errors: string[] = []
    for (const serial of serials) {
        const json = call(context, 'products_list', { serial }, errors)
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
                contractNumber: text(field(asset, 'contractNumber')),
                serviceLevel: latest?.level ?? '',
                startDate: latest?.start,
                endDate: latest?.end,
            })
        }
    }
    return { facts, errors }
}

// --- HPE Mist (JSI inventory) ----------------------------------------------------------------

function mistItems(context: OemContext, fn: 'jsi_by_model' | 'jsi_by_serial', params: Record<string, string>, errors: string[]): unknown[] {
    for (const orgId of context.orgIds) {
        const items = asArray(call(context, fn, { org_id: orgId, ...params }, errors))
        if (items.length > 0) return items
    }
    return []
}

const mistLifecycle: Capability<LifecycleFact> = (pids, context) => {
    const facts: LifecycleFact[] = []
    const errors: string[] = []
    for (const pid of pids) {
        const item = mistItems(context, 'jsi_by_model', { model: pid }, errors).find((i) => field(i, 'eos_time') || field(i, 'eol_time'))
        if (!item) continue
        facts.push({
            pid,
            dates: { endOfSale: isoDate(field(item, 'eos_time')), endOfLife: isoDate(field(item, 'eol_time')) },
            reference: 'mist:jsi',
        })
    }
    return { facts, errors }
}

const mistCoverage: Capability<CoverageFact> = (serials, context) => {
    const facts: CoverageFact[] = []
    const errors: string[] = []
    for (const serial of serials) {
        const item = mistItems(context, 'jsi_by_serial', { serial }, errors)[0]
        if (!item) continue
        const end = isoDate(field(item, 'warranty_end_time')) ?? isoDate(field(item, 'contract_end_time'))
        facts.push({
            serial,
            covered: !!end,
            contractNumber: text(field(item, 'contract_id')),
            serviceLevel: text(field(item, 'warranty_type')) || text(field(item, 'contract_type')),
            startDate: isoDate(field(item, 'warranty_start_time')) ?? isoDate(field(item, 'contract_start_time')),
            endDate: end,
        })
    }
    return { facts, errors }
}

interface Route<T> {
    /** Vendor whose REST message serves the call (Meraki hardware coverage comes from Cisco SN2INFO). */
    via: OemVendor
    run: Capability<T>
}

/** What each vendor's API can do; missing capabilities fall back to CSV import. */
export const OEM_ADAPTERS: Record<
    OemVendor,
    { lifecycle?: Route<LifecycleFact>; coverage?: Route<CoverageFact>; rmaStatus?: Route<RmaFact> }
> = {
    cisco: {
        lifecycle: { via: 'cisco', run: ciscoLifecycle },
        coverage: { via: 'cisco', run: ciscoCoverage },
        rmaStatus: { via: 'cisco', run: ciscoRmaStatus },
    },
    meraki: { lifecycle: { via: 'meraki', run: merakiLifecycle }, coverage: { via: 'cisco', run: ciscoCoverage } },
    fortinet: { coverage: { via: 'fortinet', run: fortinetCoverage } },
    mist: { lifecycle: { via: 'mist', run: mistLifecycle }, coverage: { via: 'mist', run: mistCoverage } },
    aruba: {},
    checkpoint: {},
}
