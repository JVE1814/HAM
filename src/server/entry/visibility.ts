import { GlideRecord, gs } from '@servicenow/glide'
import {
    deletesFleetAsset,
    grantsContactRecord,
    grantsNaasRecord,
    grantsReturnOfOwnCustomer,
    readsFleetProviderField,
    rowVisible,
    SCOPED_TABLES,
    visibilityFilter,
    writesFleetAsset,
    writesFleetCommercialField,
} from '../domain/visibility.ts'
import { readsBeyondVisibility } from '../platform/beyond-visibility.ts'
import { str, type ForeignRecord } from '../platform/records.ts'
import { currentSession } from '../platform/session.ts'
import { hardwareRow, otherAssetClass, placementOf, rowOf, scopingOfTable } from '../platform/visibility.ts'

/**
 * The before-query business rules' script (shared/visibility.now.ts): restricts a list or look-up to what the user
 * may see (ADR 0005), by the scoping of the table queried. A rule on a table also runs for the queries of the tables
 * that extend it, which take its scoping. On a table the app shares with the Provider's IT (ADR 0016) an inventory tech's NaaS records only
 * are narrowed: those outside NaaS stay in, for the platform to decide. A Customer contact is kept to their Customer
 * (and Sites) on every record.
 *
 * A table with no scoping cannot be queried here unless a rule is put on a table that has no entry: it is then shown
 * to no reader the rules narrow, and logged, so the mistake hides records and never shows them.
 */
export function scopeRecords(current: ForeignRecord): void {
    if (readsBeyondVisibility(current)) return
    const scoping = scopingOfTable(current.getTableName())
    const session = currentSession()
    const filter = visibilityFilter(session.scope, scoping, session)
    if (filter) current.addEncodedQuery(filter)
}

/**
 * The Deny-Unless read ACLs' script (shared/visibility.now.ts, ADR 0005), on the tables the rules narrow to an
 * inventory tech's Stockrooms: a record is read only when the table's before-query rule would have kept it. A rule
 * can only append conditions, which an `^NQ` in the query binds to its last clause, so a list or a direct link can
 * reach a record the rule would hide; the ACL denies it. It decides on the same scoping as the rule (domain/visibility
 * `rowVisible`), so on a shared table it passes a record outside NaaS where the rule leaves it in. A record that is
 * not a saved row (a New form, a check of the whole table) passes: it holds nothing to hide.
 *
 * Any other table with no scoping is refused to a reader the rules narrow, and logged, as
 * scopeRecords does.
 */
export function readsRecord(current: GlideRecord): boolean {
    const session = currentSession()
    const table = current.getTableName()
    if (placementOf(table).asset) {
        return otherAssetClass(current) || rowVisible(session.scope, SCOPED_TABLES.alm_hardware, hardwareRow(current), session)
    }
    const scoping = scopingOfTable(table)
    return rowVisible(session.scope, scoping, rowOf(current, scoping), session)
}

/**
 * Grant of the app's Allow-If read ACLs on alm_asset (NaaS provider staff, Customer contacts): a fleet asset the
 * reader's scope keeps. Any other Asset is left to the platform's ACLs.
 */
export function grantsFleetAsset(current: GlideRecord): boolean {
    if (otherAssetClass(current)) return false
    const session = currentSession()
    return grantsNaasRecord(session.scope, SCOPED_TABLES.alm_hardware, hardwareRow(current), session)
}

/*
 * Changes to hardware by hand (fleet/access.now.ts, ADR 0005): Deny-Unless ACLs on alm_asset, beside the
 * platform's Allow-If ones there, which the platform's `asset` role (inventory and field techs hold it) passes for every
 * Asset. On a fleet asset they keep saving to the asset editors whose scope keeps it, deleting to app administrators,
 * and the company and cost to asset managers (domain/visibility); any other Asset passes, left to the platform.
 */

const hasRole = (role: string): boolean => gs.hasRole(role)

export function writesAsset(current: GlideRecord): boolean {
    if (otherAssetClass(current)) return true
    const session = currentSession()
    return writesFleetAsset(session.scope, hasRole, hardwareRow(current), session)
}

export function deletesAsset(current: GlideRecord): boolean {
    if (otherAssetClass(current)) return true
    return deletesFleetAsset(hasRole, hardwareRow(current))
}

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
 * Grant of the Customer contacts' Allow-If read ACLs on the app's own tables (each feature's access.now.ts): a record
 * of the reader's Customer and, for a site contact who is no Customer admin, of a Site that lists them, on the fields
 * the table's before-query rule filters on. So a direct link, a dot-walk
 * from a visible record or a table with no rule (return lines, attestation items, shipment events, Site templates and
 * their items) shows a contact no other Customer's or Site's record. It decides for the contact the ACL's roles admit, whatever else the user holds: staff read through their
 * own ACLs. The reader's Customer and Sites are read once per transaction (platform/session), so a row costs no query.
 *
 * It is also the grant of the customer admins' create ACL on Orders: an Order that names their own Customer, and none
 * that names no Customer (a record that is not a saved row is judged by its values).
 */
export function grantsCustomerRecord(current: GlideRecord): boolean {
    const session = currentSession()
    const scoping = scopingOfTable(current.getTableName())
    return grantsContactRecord(session.contactScope(), scoping, rowOf(current, scoping), session)
}

export function createsCustomerReturn(current: GlideRecord): boolean {
    return grantsReturnOfOwnCustomer(currentSession().customerId, str(current, SCOPED_TABLES.x_daas_ham_return_order.customer))
}
