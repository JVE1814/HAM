import { GlideRecord, GlideTableHierarchy } from '@servicenow/glide'
import { andEachClause } from '../domain/encoded-query.ts'
import { memoized } from '../domain/memo.ts'
import { SCOPED_TABLES, scopingOf, visibilityFilter, type ScopedRow, type ScopedTable, type TableScoping } from '../domain/visibility.ts'
import { beyondVisibility } from './beyond-visibility.ts'
import { log } from './log.ts'
import { str } from './records.ts'
import { currentSession } from './session.ts'

/**
 * `query` on `table` kept to what the signed-in user may see: their visibility filter is ANDed into each of its `^NQ`
 * clauses. The table's before-query rule appends the same filter, which an `^NQ` binds to the last clause only, and a
 * server read meets no read ACL to remove the rest (ADR 0005), so a query with `^NQ` clauses that must stay within the
 * reader's view runs through this.
 */
export function visibleQuery(table: ScopedTable, query: string): string {
    const session = currentSession()
    const filter = visibilityFilter(session.scope, SCOPED_TABLES[table], session)
    return filter ? andEachClause(query, filter) : query
}

const ASSET_TABLE = 'alm_asset'
const HARDWARE = SCOPED_TABLES.alm_hardware
const TRANSFER_ORDER = SCOPED_TABLES.alm_transfer_order

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

export interface Placement {
    scoping: TableScoping | null
    /** Whether it is alm_asset or one of its classes, the tables the app's ACLs on alm_asset are asked about. */
    asset: boolean
}

/*
 * Placed once per table and transaction (a module's state lasts one transaction, docs/research/external-contracts.md
 * N37). A table with an entry of its own, as every table a rule or an ACL of the app sits on has, costs no look-up of
 * its hierarchy.
 */
export const placementOf = memoized((table: string): Placement => {
    const own = scopingOf([table])
    if (own) return { scoping: own, asset: own === HARDWARE }
    if (table === ASSET_TABLE) return { scoping: null, asset: true }
    const tables = withParents(table)
    return { scoping: scopingOf(tables), asset: tables.includes(ASSET_TABLE) }
})

const warnUnplaced = memoized((table: string) => {
    log.warn(`NaaS visibility: ${table} is no scoped table and extends none, so it shows a reader the rules narrow nothing`)
    return true
})

/**
 * The scoping of `table` or of the table it extends. A table with none shows a reader the rules narrow no record, so
 * it is logged, once per table and transaction.
 */
export function scopingOfTable(table: string): TableScoping | null {
    const { scoping } = placementOf(table)
    if (!scoping) warnUnplaced(table)
    return scoping
}

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

/**
 * A transfer order, with its Stockrooms read past the app's visibility rules, as hardwareOf reads hardware: a dot-walk
 * to a Stockroom the reader's rule hides reads a blank type, which would take the order for one outside NaaS. A
 * Stockroom it names that is not found leaves the order missing, so it is not taken for one.
 */
function transferOrderRow(current: GlideRecord): ScopedRow {
    const own = scopedRow(current)
    const stockroomOf = memoized((column: string): GlideRecord | null => {
        const stockroom = new GlideRecord('alm_stockroom')
        return beyondVisibility(stockroom, () => stockroom.get(str(current, column))) ? stockroom : null
    })
    const named = TRANSFER_ORDER.stockroom.filter((column) => str(current, column) !== '')
    return {
        saved: own.saved,
        valueOf: (field) => {
            const [column = '', ...rest] = field.split('.')
            if (rest.length === 0) return own.valueOf(field)
            const stockroom = stockroomOf(column)
            return stockroom ? str(stockroom, rest.join('.')) : ''
        },
        missing: () => named.some((column) => stockroomOf(column) === null),
    }
}

export function rowOf(current: GlideRecord, scoping: TableScoping | null): ScopedRow {
    return scoping === TRANSFER_ORDER ? transferOrderRow(current) : scopedRow(current)
}

/*
 * The app's read ACLs for hardware sit on alm_asset, its parent (ADR 0005): alm_hardware then has none of the app's
 * and inherits alm_asset's, the platform's and the app's together, and a list of alm_asset is checked as well. Those
 * ACLs apply to hardware only (Applies To), and their scripts check the class again in case Applies To is not applied.
 */

/** Whether `current` is an Asset of another class than hardware (a consumable, licence or facility): not the app's. */
export function otherAssetClass(current: GlideRecord): boolean {
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

export function hardwareRow(current: GlideRecord): ScopedRow {
    return scopedRow(current, () => hardwareOf(current))
}
