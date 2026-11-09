import { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { closeAudit, recordScan, startSiteAudit, startStockroomAudit } from './audits.ts'

/*
 * Audits run against in-memory tables. What they must keep: an audit expects only the Assets the platform let it list,
 * closing gives every line its result from one comparison, raises one exception per missing Asset however often it is
 * closed, and an audit the user may not work on is left as it was.
 */

type Row = Record<string, string>

const platform = vi.hoisted(() => ({
    tables: {} as Record<string, Array<Record<string, string>>>,
    /** Why a save of `row` to `table` is refused ('' when it is not). */
    refuses: (() => '') as (table: string, row: Record<string, string>) => string,
    warnings: [] as string[],
    ids: 0,
    installed: [] as string[],
    workOrder: 'wo1' as string | null,
}))

/** The table a reference field of the fake tables points at, for dot-walks. */
const REFERENCES: Record<string, string> = { asset: 'alm_hardware' }

vi.mock('@servicenow/glide', () => {
    const rowsOf = (table: string): Row[] => (platform.tables[table] ??= [])
    /** One AND term of a query: the row matches any of its field/value alternatives. */
    type Term = Array<[field: string, value: string]>
    class GlideRecord {
        private terms: Term[] = []
        private limit = Infinity
        private found: Row[] = []
        private at = -1
        private row: Row = {}
        private error = ''
        constructor(private readonly table: string) {}
        addQuery(field: string, value: string | boolean): { addOrCondition(field: string, value: string): void } {
            const term: Term = [[field, String(value)]]
            this.terms.push(term)
            return { addOrCondition: (other, otherValue) => void term.push([other, otherValue]) }
        }
        addActiveQuery(): void {
            this.addQuery('active', 'true')
        }
        addEncodedQuery(query: string): void {
            for (const term of query.split('^')) {
                const [field, value] = term.split('=')
                this.addQuery(field ?? '', value ?? '')
            }
        }
        setLimit(limit: number): void {
            this.limit = limit
        }
        query(): void {
            this.found = rowsOf(this.table)
                .filter((row) => this.terms.every((term) => term.some(([field, value]) => (row[field] ?? '') === value)))
                .slice(0, this.limit)
            this.at = -1
        }
        hasNext(): boolean {
            return this.at + 1 < this.found.length
        }
        next(): boolean {
            this.at++
            const row = this.found[this.at]
            if (row) this.row = { ...row }
            return row !== undefined
        }
        get(sysId: string): boolean {
            this.addQuery('sys_id', sysId)
            this.query()
            return this.next()
        }
        initialize(): void {
            this.row = {}
        }
        getValue(field: string): string | null {
            return this.row[field] ?? null
        }
        getElement(path: string): { getValue(): string | null } {
            const [reference, field] = path.split('.')
            const target = rowsOf(REFERENCES[reference] ?? '').find((row) => row.sys_id === this.row[reference])
            return { getValue: () => target?.[field] ?? null }
        }
        setValue(field: string, value: string | boolean | number): void {
            this.row[field] = String(value)
        }
        getUniqueValue(): string {
            return this.row.sys_id ?? ''
        }
        getLastErrorMessage(): string {
            return this.error
        }
        insert(): string | null {
            this.error = platform.refuses(this.table, this.row)
            if (this.error) return null
            this.row.sys_id = `${this.table}-${++platform.ids}`
            // What the platform fills in on insert: an audit's number and active flag, an exception's default status.
            if (this.table === 'x_daas_ham_audit') Object.assign(this.row, { number: `AUD${platform.ids}`, active: 'true' })
            if (this.table === 'x_daas_ham_recon_exception') this.row.status = 'open'
            rowsOf(this.table).push({ ...this.row })
            return this.row.sys_id
        }
        update(): string | null {
            this.error = platform.refuses(this.table, this.row)
            if (this.error) return null
            Object.assign(rowsOf(this.table).find((row) => row.sys_id === this.row.sys_id) ?? {}, this.row)
            return this.row.sys_id ?? null
        }
    }
    const gs = { warn: (message: string) => void platform.warnings.push(message), getUserID: () => 'user1' }
    return { GlideRecord, GlideAggregate: class {}, GlideDateTime: class {}, gs }
})

vi.mock('./session.ts', () => ({ currentSession: () => ({ scope: 'everything', customerId: '', stockroomIds: () => [], siteIds: () => [] }) }))
vi.mock('./clock.ts', () => ({ nowGlide: () => '2026-11-09 10:00:00' }))
vi.mock('./locks.ts', () => ({ withLockTries: (_name: string, work: () => void) => work() }))
vi.mock('./installed-assets.ts', () => ({ installedAssetIds: () => platform.installed }))
vi.mock('./field-work.ts', () => ({ openFieldWork: () => (platform.workOrder ? { workOrderId: platform.workOrder } : null) }))

const AUDITS = 'x_daas_ham_audit'
const LINES = 'x_daas_ham_audit_line'
const EXCEPTIONS = 'x_daas_ham_recon_exception'

const rows = (table: string): Row[] => platform.tables[table] ?? []

function record(table: string, sysId: string): GlideRecord {
    const found = new GlideRecord(table)
    found.get(sysId)
    return found
}

/** An open audit expecting Assets a1 (scanned by its tag), a2 (not scanned) and a3 (scanned by serial), with one scan that matches nothing. */
function countedAudit(): GlideRecord {
    platform.tables.alm_hardware = [
        { sys_id: 'a1', serial_number: 'FOC111', asset_tag: 'NAAS-1', company: 'acme' },
        { sys_id: 'a2', serial_number: 'FOC222', asset_tag: 'NAAS-2', company: 'acme' },
        { sys_id: 'a3', serial_number: 'FOC333', asset_tag: '', company: 'globex' },
    ]
    platform.tables[AUDITS] = [{ sys_id: 'audit1', number: 'AUD1', active: 'true', state: '2' }]
    platform.tables[LINES] = [
        ...['a1', 'a2', 'a3'].map((asset) => ({ sys_id: `line-${asset}`, audit: 'audit1', asset })),
        ...['naas-1', 'FOC333', 'XYZ'].map((code) => ({ sys_id: `scan-${code}`, audit: 'audit1', scanned_code: code, result: 'found' })),
    ]
    return record(AUDITS, 'audit1')
}

const resultOf = (lineId: string) => rows(LINES).find((line) => line.sys_id === lineId)?.result

beforeEach(() => {
    platform.tables = {}
    platform.refuses = () => ''
    platform.warnings = []
    platform.ids = 0
    platform.installed = []
    platform.workOrder = 'wo1'
})

describe('closeAudit', () => {
    it('gives every line its result, counts them on the audit and raises an exception for the missing Asset', () => {
        expect(closeAudit(countedAudit())).toBe('closed')
        expect(['line-a1', 'line-a2', 'line-a3'].map(resultOf)).toEqual(['found', 'missing', 'found'])
        expect(['scan-naas-1', 'scan-FOC333', 'scan-XYZ'].map(resultOf)).toEqual(['found', 'found', 'unexpected'])
        expect(rows(AUDITS)[0]).toMatchObject({ matched_count: '2', missing_count: '1', unexpected_count: '1', state: '3' })
        expect(rows(EXCEPTIONS)).toEqual([
            expect.objectContaining({ exception_type: 'audit_missing', asset: 'a2', ci: '', customer: 'acme', detail: 'Not found in AUD1' }),
        ])
    })

    it('raises no second exception when the close is refused and made again', () => {
        platform.refuses = (table) => (table === AUDITS ? 'no' : '')
        expect(closeAudit(countedAudit())).toBe('not_saved')
        expect(platform.warnings).toEqual(['[x_daas_ham] Audit AUD1 not closed: no'])
        platform.refuses = () => ''
        expect(closeAudit(record(AUDITS, 'audit1'))).toBe('closed')
        expect(rows(EXCEPTIONS)).toHaveLength(1)
    })

    it('leaves an audit that is not open as it was', () => {
        const audit = countedAudit()
        rows(AUDITS)[0].active = 'false'
        expect(closeAudit(audit)).toBe('not_open')
        expect(resultOf('line-a2')).toBeUndefined()
        expect(rows(EXCEPTIONS)).toEqual([])
    })
})

describe('starting an audit', () => {
    const site = () => {
        platform.tables.cmn_location = [{ sys_id: 'site1', name: 'Acme HQ', company: 'acme' }]
        return record('cmn_location', 'site1')
    }

    it('expects the Assets installed at the Site and links the work order, saved once the list is made', () => {
        platform.installed = ['a1', 'a2']
        expect(startSiteAudit(site())).toEqual({ started: true, workOrderOpened: true, number: 'AUD1', expected: 2, leftOff: 0 })
        expect(rows(AUDITS)[0]).toMatchObject({ audit_type: 'site', site: 'site1', customer: 'acme', state: '2', expected_count: '2', work_order: 'wo1' })
        expect(rows(LINES).map((line) => line.asset)).toEqual(['a1', 'a2'])
    })

    it('leaves an Asset the platform refuses off the count, and says when no work order was opened', () => {
        platform.installed = ['a1', 'a2']
        platform.workOrder = null
        platform.refuses = (table, row) => (table === LINES && row.asset === 'a2' ? 'no' : '')
        expect(startSiteAudit(site())).toEqual({ started: true, workOrderOpened: false, number: 'AUD1', expected: 1, leftOff: 1 })
        expect(rows(AUDITS)[0].expected_count).toBe('1')
        expect(platform.warnings).toEqual(['[x_daas_ham] Asset a2 left off audit AUD1: no'])
    })

    it('starts none the platform refuses, and no blind count of a stockroom outside NaaS', () => {
        platform.refuses = (table) => (table === AUDITS ? 'not allowed' : '')
        expect(startSiteAudit(site())).toEqual({ started: false, reason: 'not allowed' })
        platform.tables.alm_stockroom = [{ sys_id: 'sr1', name: 'IT store', x_daas_ham_stockroom_type: '' }]
        expect(startStockroomAudit(record('alm_stockroom', 'sr1'))).toEqual({
            started: false,
            reason: 'this is not a NaaS stockroom (it has no stockroom type)',
        })
        expect(rows(AUDITS)).toEqual([])
    })
})

describe('recordScan', () => {
    it('records the scan as found, or says why the platform refused it', () => {
        const audit = countedAudit()
        expect(recordScan(audit, 'FOC222')).toBe('')
        expect(rows(LINES).at(-1)).toMatchObject({ audit: 'audit1', scanned_code: 'FOC222', result: 'found', scanned_at: '2026-11-09 10:00:00' })
        platform.refuses = () => 'full'
        expect(recordScan(audit, 'FOC222')).toBe('full')
    })
})
