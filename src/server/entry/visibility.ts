import { GlideRecord, GlideTableHierarchy, gs } from '@servicenow/glide'
import { memoized } from '../domain/memo.ts'
import {
    deletesFleetAsset,
    grantsContactRecord,
    grantsNaasRecord,
    grantsReturnOfOwnCustomer,
    readsFleetProviderField,
    rowVisible,
    SCOPED_TABLES,
    scopingOf,
    visibilityFilter,
    writesFleetAsset,
    writesFleetCommercialField,
    type ScopedRow,
    type TableScoping,
} from '../domain/visibility.ts'
import { beyondVisibility, readsBeyondVisibility } from '../platform/beyond-visibility.ts'
import { str, type ForeignRecord } from '../platform/records.ts'
import { currentSession } from '../platform/session.ts'


/*
 * Every script here finds what to do from the table of the record it is handed (domain/visibility SCOPED_TABLES), so a
 * rule or an ACL is scoped by the table it sits on and nothing is chosen in the metadata.
 */

const ASSET_TABLE = 'alm_asset'
const HARDWARE = SCOPED_TABLES.alm_hardware

/**
 * `table`, then each table it extends, nearest first (the scoped GlideTableHierarchy#getTables, documented to give an
 * array of names; a list of another kind is read from its text). None when the platform gives no list or refuses:
 * the table is then one the app cannot place, which hides records and never shows them.
 */
function withParents(table: string): string[] {
    try {
        const tables: unknown = new GlideTableHierarchy(table).getTables()
        const names: unknown[] = Array.isArray(tables) ? tables : String(tables ?? '').split(',')
        return names.map((name) => String(name).replace(/[^\w]/g, '')).filter(Boolean)
    } catch {
        return []
    }
}

/** Where the app's visibility places a table. */
interface Placement {
    /** Its scoping: its own entry or, for a table that extends a scoped one, its nearest parent's. Null for none. */
    scoping: TableScoping | null
    /** Whether it is alm_asset or one of its classes, the tables the app's ACLs on alm_asset are asked about. */
    asset: boolean
}

/*
 * Placed once per table and transaction (a module's state lasts one transaction, docs/research/external-contracts.md
 * N37). A table with an entry of its own, as every table a rule or an ACL of the app sits on has, costs no look-up of
 * its hierarchy.
 */
const placementOf = memoized((table: string): Placement => {
    const own = scopingOf([table])
    if (own) return { scoping: own, asset: own === HARDWARE }
    if (table === ASSET_TABLE) return { scoping: null, asset: true }
    const tables = withParents(table)
    return { scoping: scopingOf(tables), asset: tables.includes(ASSET_TABLE) }
})

const warnUnplaced = memoized((table: string) => {
    gs.warn(`NaaS visibility: ${table} is no scoped table and extends none, so it shows a reader the rules narrow nothing`)
    return true
})

/**
 * The before-query business rules' script (security/visibility.now.ts): restricts a list or look-up to what the user
 * may see (ADR 0005), by the scoping of the table queried. A rule on a table also runs for the queries of the tables
 * that extend it, which take its scoping. A query the app's own logic runs past the rules (platform/beyond-visibility)
 * is left as it is. On a table the app shares with the Provider's IT (ADR 0016) an inventory tech's NaaS records only
 * are narrowed: those outside NaaS stay in, for the platform to decide. A Customer contact is kept to their Customer
 * (and Sites) on every record.
 *
 * A table with no scoping cannot be queried here unless a rule is put on a table that has no entry: it is then shown
 * to no reader the rules narrow, and logged, so the mistake hides records and never shows them.
 */
export function scopeRecords(current: ForeignRecord): void {
    if (readsBeyondVisibility(current)) return
    const table = current.getTableName()
    const { scoping } = placementOf(table)
    if (!scoping) warnUnplaced(table)
    const session = currentSession()
    const filter = visibilityFilter(session.scope, scoping, session)
    if (filter) current.addEncodedQuery(filter)
}

/** `current` as domain/visibility reads a row: the record that holds the fields is loaded once, and only if one is read. */
function scopedRow(current: GlideRecord, holder?: () => GlideRecord | null): ScopedRow {
    let loaded: GlideRecord | null | undefined
    const record = (): GlideRecord | null => {
        if (loaded === undefined) loaded = holder ? holder() : current
        return loaded
    }
    return {
        saved: !current.isNewRecord() && !!current.getUniqueValue(),
        valueOf: (field) => {
            const found = record()
            return found ? str(found, field) : ''
        },
        missing: holder ? () => record() === null : undefined,
    }
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

function hardwareRow(current: GlideRecord): ScopedRow {
    return scopedRow(current, () => hardwareOf(current))
}

/**
 * The Deny-Unless read ACLs' script (security/acls-visibility.now.ts, ADR 0005), on the tables the rules narrow to an
 * inventory tech's Stockrooms: a record is read only when the table's before-query rule would have kept it. A rule
 * can only append conditions, which an `^NQ` in the query binds to its last clause, so a list or a direct link can
 * reach a record the rule would hide; the ACL denies it. It decides on the same scoping as the rule (domain/visibility
 * `rowVisible`), so on a shared table it passes a record outside NaaS where the rule leaves it in. A record that is
 * not a saved row (a New form, a check of the whole table) passes: it holds nothing to hide.
 *
 * An Asset (the ACL on alm_asset) of another class than hardware passes; hardware is checked as its rule keeps it, on
 * its alm_hardware record. Any other table with no scoping is refused to a reader the rules narrow, and logged, as
 * scopeRecords does.
 */
export function readsRecord(current: GlideRecord): boolean {
    const session = currentSession()
    const table = current.getTableName()
    const { scoping, asset } = placementOf(table)
    if (asset) return otherAssetClass(current) || rowVisible(session.scope, HARDWARE, hardwareRow(current), session)
    if (!scoping) warnUnplaced(table)
    return rowVisible(session.scope, scoping, scopedRow(current), session)
}

/**
 * Grant of the app's Allow-If read ACLs on alm_asset (NaaS provider staff, Customer contacts): a fleet asset the
 * reader's scope keeps (domain/visibility `grantsNaasRecord`). Any other Asset is left to the platform's ACLs.
 */
export function grantsFleetAsset(current: GlideRecord): boolean {
    if (otherAssetClass(current)) return false
    const session = currentSession()
    return grantsNaasRecord(session.scope, HARDWARE, hardwareRow(current), session)
}

/*
 * Changes to hardware by hand (security/acls-hardware.now.ts, ADR 0005): Deny-Unless ACLs on alm_asset, beside the
 * platform's Allow-If ones there, which the platform's `asset` role (inventory and field techs hold it) passes for every
 * Asset. On a fleet asset they keep saving to the asset editors whose scope keeps it, deleting to app administrators,
 * and the company and cost to asset managers (domain/visibility); any other Asset passes, left to the platform.
 */

const hasRole = (role: string): boolean => gs.hasRole(role)

/** Row check of the Deny-Unless write ACL on alm_asset: a fleet asset is saved only by an asset editor who sees it. */
export function writesAsset(current: GlideRecord): boolean {
    if (otherAssetClass(current)) return true
    const session = currentSession()
    return writesFleetAsset(session.scope, hasRole, hardwareRow(current), session)
}

/** Check of the Deny-Unless delete ACL on alm_asset: a fleet asset is deleted only by an app administrator. */
export function deletesAsset(current: GlideRecord): boolean {
    if (otherAssetClass(current)) return true
    return deletesFleetAsset(hasRole, hardwareRow(current))
}

/** Check of the Deny-Unless write ACLs on alm_asset.company and alm_asset.cost: an asset manager's, on a fleet asset. */
export function writesAssetCommercialField(current: GlideRecord): boolean {
    if (otherAssetClass(current)) return true
    return writesFleetCommercialField(hasRole, hardwareRow(current))
}

/** Check of the Deny-Unless read ACL on alm_asset.cost: a fleet asset's cost is not a Customer contact's to read. */
export function readsAssetCost(current: GlideRecord): boolean {
    if (otherAssetClass(current)) return true
    return readsFleetProviderField(currentSession().scope, hardwareRow(current))
}

/**
 * Grant of the Customer contacts' Allow-If read ACLs on the app's own tables (security/acls.now.ts,
 * acls-logistics.now.ts): a record of the reader's Customer and, for a site contact who is no Customer admin, of a
 * Site that lists them, on the fields the table's before-query rule filters on (domain/visibility
 * `grantsContactRecord`). So a direct link, a dot-walk from a visible record or a table with no rule (return lines,
 * attestation items, shipment events, Site templates and their items) shows a contact no other Customer's or Site's
 * record. It decides for the contact the ACL's roles admit, whatever else the user holds: staff read through their
 * own ACLs. The reader's Customer and Sites are read once per transaction (platform/session), so a row costs no query.
 *
 * It is also the grant of the customer admins' create ACL on Orders: an Order that names their own Customer, and none
 * that names no Customer (a record that is not a saved row is judged by its values).
 */
export function grantsCustomerRecord(current: GlideRecord): boolean {
    const session = currentSession()
    const table = current.getTableName()
    const { scoping } = placementOf(table)
    if (!scoping) warnUnplaced(table)
    return grantsContactRecord(session.contactScope(), scoping, scopedRow(current), session)
}

/**
 * Grant of the customer admins' create ACL on Returns (security/acls.now.ts): a Return of their own Customer, or one
 * that names none yet (domain/visibility `grantsReturnOfOwnCustomer`).
 */
export function createsCustomerReturn(current: GlideRecord): boolean {
    return grantsReturnOfOwnCustomer(currentSession().customerId, str(current, SCOPED_TABLES.x_daas_ham_return_order.customer))
}
