import { GlideRecord } from '@servicenow/glide'
import { naasStockroomType, STOCKROOM_TYPE_FIELD } from '../domain/fleet.ts'
import {
    grantsNaasRecord,
    OUTSIDE_NAAS,
    rowVisible,
    SCOPE,
    visibilityFilter,
    type ScopedRecords,
    type ScopedRow,
} from '../domain/visibility.ts'
import { isFleetAsset } from '../platform/assets.ts'
import { beyondVisibility, readsBeyondVisibility } from '../platform/beyond-visibility.ts'
import { str } from '../platform/records.ts'
import { currentSession } from '../platform/session.ts'

// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.

/**
 * Before-query business rules that restrict lists and lookups to what the user may see (ADR 0005). A query the app's
 * own logic runs past them (platform/beyond-visibility) is left as it is. On a table the app shares with the Provider's
 * IT (ADR 0016) a rule narrows an inventory tech's NaaS records only: those OUTSIDE_NAAS matches stay in, for the
 * platform to decide. A Customer contact is kept to their Customer (and Sites) on every record.
 */

function restrict(current: GlideRecord, records: ScopedRecords): void {
    if (readsBeyondVisibility(current)) return
    const session = currentSession()
    const filter = visibilityFilter(session.scope, SCOPE[records], session, OUTSIDE_NAAS[records])
    if (filter) current.addEncodedQuery(filter)
}

export function scopeAssets(current: GlideRecord): void {
    restrict(current, 'assets')
}

export function scopeStockrooms(current: GlideRecord): void {
    restrict(current, 'stockrooms')
}

export function scopeTransferOrders(current: GlideRecord): void {
    restrict(current, 'transferOrders')
}

export function scopeStagingTasks(current: GlideRecord): void {
    restrict(current, 'stagingTasks')
}

/** An inventory tech sees the blind counts of their Stockrooms; a site audit has no Stockroom, so it drops out. */
export function scopeAudits(current: GlideRecord): void {
    restrict(current, 'audits')
}

export function scopeAuditLines(current: GlideRecord): void {
    restrict(current, 'auditLines')
}

export function scopeOrders(current: GlideRecord): void {
    restrict(current, 'orders')
}

export function scopeOrderLines(current: GlideRecord): void {
    restrict(current, 'orderLines')
}

export function scopeCustomerRecords(current: GlideRecord): void {
    restrict(current, 'customerRecords')
}

export function scopeCustomerSiteRecords(current: GlideRecord): void {
    restrict(current, 'customerSiteRecords')
}

/**
 * Row checks of the Deny-Unless read ACLs (security/acls-visibility.now.ts, ADR 0005) on the tables the rules narrow to
 * an inventory tech's Stockrooms: a record is read only when the before-query rule would have kept it. A rule can only
 * append conditions, which an `^NQ` in the query binds to its last clause, so a list or a direct link can reach a
 * record the rule would hide; the ACL denies it. Each reads the fields of the same SCOPE as its table's rule, and on a
 * shared table it passes a record outside NaaS where the rule leaves it in (domain/visibility `leavesOutsideNaas`).
 * A record that is not a saved row (a New form, a check of the whole table) passes: it holds nothing to hide.
 */

/** Where a row check reads a record's scoping fields, and how it tells a record outside NaaS on a shared table. */
interface RowSource {
    /** The record that holds the fields: `current` unless given (an Asset's hardware record, hardwareOf). */
    record?: () => GlideRecord | null
    /** Whether the record is one OUTSIDE_NAAS matches; omitted on the app's own tables. */
    outsideNaas?: (record: GlideRecord) => boolean
}

/** `current` as domain/visibility reads a row, its record loaded once and only if a field is read. */
function scopedRow(current: GlideRecord, source: RowSource = {}): ScopedRow {
    let loaded: GlideRecord | null | undefined
    const record = (): GlideRecord | null => {
        if (loaded === undefined) loaded = source.record ? source.record() : current
        return loaded
    }
    const outsideNaas = source.outsideNaas
    return {
        saved: !current.isNewRecord() && !!current.getUniqueValue(),
        valueOf: (field) => {
            const found = record()
            return found ? str(found, field) : ''
        },
        outsideNaas: outsideNaas
            ? () => {
                  const found = record()
                  return !!found && outsideNaas(found)
              }
            : undefined,
    }
}

function readable(current: GlideRecord, records: ScopedRecords, source?: RowSource): boolean {
    const session = currentSession()
    return rowVisible(session.scope, SCOPE[records], scopedRow(current, source), session)
}

/** Whether the Stockroom `via` dot-walks to is a NaaS stockroom (one with a NaaS stockroom type). */
function naasStockroom(record: GlideRecord, via = ''): boolean {
    return naasStockroomType(str(record, `${via}${STOCKROOM_TYPE_FIELD}`)) !== null
}

/*
 * The app's read ACLs for hardware sit on alm_asset, its parent (ADR 0005): alm_hardware then has none of the app's
 * and inherits alm_asset's, the platform's and the app's together, and a list of alm_asset is checked as well. Those
 * ACLs apply to hardware only (Applies To), and their scripts check the class again in case Applies To is not applied.
 */

/** Whether `current` is an Asset of another class than hardware (a consumable, licence or facility): not the app's. */
function otherAssetClass(current: GlideRecord): boolean {
    const assetClass = str(current, 'sys_class_name')
    return assetClass !== '' && assetClass !== 'alm_hardware'
}

/**
 * The hardware record an Asset ACL is asked about: `current` itself on an alm_hardware list or form; for a row of an
 * alm_asset list, which carries no hardware field (the Fleet flag, the Site), its alm_hardware record, read past the
 * app's visibility rules (platform/beyond-visibility) so the check sees the record and not the rule's verdict. Null
 * when it is not found, which the row check then refuses a scoped reader.
 */
function hardwareOf(current: GlideRecord): GlideRecord | null {
    if (current.getTableName() === 'alm_hardware') return current
    const hardware = new GlideRecord('alm_hardware')
    return beyondVisibility(hardware, () => hardware.get(current.getUniqueValue())) ? hardware : null
}

function hardwareSource(current: GlideRecord): RowSource {
    return { record: () => hardwareOf(current), outsideNaas: (hardware) => !isFleetAsset(hardware) }
}

/** Row check of an Asset (Deny-Unless, on alm_asset): another class passes; hardware is checked as its rule keeps it. */
export function readsAsset(current: GlideRecord): boolean {
    return otherAssetClass(current) || readable(current, 'assets', hardwareSource(current))
}

/**
 * Grant of the app's Allow-If read ACLs on alm_asset (NaaS provider staff, Customer contacts): a fleet asset the
 * reader's scope keeps (domain/visibility `grantsNaasRecord`). Any other Asset is left to the platform's ACLs.
 */
export function grantsFleetAsset(current: GlideRecord): boolean {
    if (otherAssetClass(current)) return false
    const session = currentSession()
    return grantsNaasRecord(session.scope, SCOPE.assets, scopedRow(current, hardwareSource(current)), session)
}

export function readsStockroom(current: GlideRecord): boolean {
    return readable(current, 'stockrooms', { outsideNaas: (stockroom) => !naasStockroom(stockroom) })
}

export function readsTransferOrder(current: GlideRecord): boolean {
    return readable(current, 'transferOrders', {
        outsideNaas: (order) => !naasStockroom(order, 'from_stockroom.') && !naasStockroom(order, 'to_stockroom.'),
    })
}

export function readsStagingTask(current: GlideRecord): boolean {
    return readable(current, 'stagingTasks')
}

export function readsAudit(current: GlideRecord): boolean {
    return readable(current, 'audits')
}

export function readsAuditLine(current: GlideRecord): boolean {
    return readable(current, 'auditLines')
}
