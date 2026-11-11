import { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { closeAudit, recordScan, startSiteAudit, startStockroomAudit } from './audits.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

/*
 * Audits run against in-memory tables. What they must keep: an audit expects only the Assets the platform let it list,
 * closing gives every line its result from one comparison, raises one exception per missing Asset however often it is
 * closed, and an audit the user may not work on is left as it was.
 */

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

/** What the services the audits call would give: the Assets installed at the Site, and the work order opened for the visit. */
const visit = vi.hoisted(() => ({ installed: [] as string[], workOrder: 'wo1' as string | null }))

vi.mock('./session.ts', () => ({ currentSession: () => ({ scope: 'everything', customerId: '', stockroomIds: () => [], siteIds: () => [] }) }))
vi.mock('./clock.ts', () => ({ nowGlide: () => '2026-11-09 10:00:00' }))
vi.mock('./locks.ts', () => ({ withLockTries: (_name: string, work: () => void) => work() }))
vi.mock('./installed-assets.ts', () => ({ installedAssetIds: () => visit.installed }))
vi.mock('./field-work.ts', () => ({ openFieldWork: () => (visit.workOrder ? { workOrderId: visit.workOrder } : null) }))

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
    platform.reset()
    platform.references = { [`${LINES}.asset`]: 'alm_hardware' }
    // What the platform fills in on insert: an audit's number and active flag, an exception's default status.
    platform.defaults = {
        [AUDITS]: () => ({ number: `AUD${rows(AUDITS).length + 1}`, active: 'true' }),
        [EXCEPTIONS]: () => ({ status: 'open' }),
    }
    visit.installed = []
    visit.workOrder = 'wo1'
})

describe('closeAudit', () => {
    it('gives every line its result, counts them on the audit and raises an exception for the missing Asset', () => {
        expect(closeAudit(countedAudit())).toEqual({ outcome: 'closed', unsaved: 0 })
        expect(['line-a1', 'line-a2', 'line-a3'].map(resultOf)).toEqual(['found', 'missing', 'found'])
        expect(['scan-naas-1', 'scan-FOC333', 'scan-XYZ'].map(resultOf)).toEqual(['found', 'found', 'unexpected'])
        expect(rows(AUDITS)[0]).toMatchObject({ matched_count: '2', missing_count: '1', unexpected_count: '1', state: '3' })
        expect(rows(EXCEPTIONS)).toEqual([
            expect.objectContaining({ exception_type: 'audit_missing', asset: 'a2', ci: '', customer: 'acme', detail: 'Not found in AUD1' }),
        ])
    })

    it('closes the audit first: one refused marks no line and raises no exception, and is closed again in full', () => {
        platform.refuses = (table) => (table === AUDITS ? 'no' : '')
        expect(closeAudit(countedAudit())).toEqual({ outcome: 'not_saved', reason: 'no' })
        // One warning, naming the audit and why the platform refused.
        expect(platform.warnings).toEqual([expect.stringMatching(/\bAUD1\b.*: no$/)])
        expect(resultOf('line-a2')).toBeUndefined()
        expect(rows(EXCEPTIONS)).toEqual([])
        platform.refuses = () => ''
        expect(closeAudit(record(AUDITS, 'audit1'))).toEqual({ outcome: 'closed', unsaved: 0 })
        expect(resultOf('line-a2')).toBe('missing')
        expect(rows(EXCEPTIONS)).toHaveLength(1)
    })

    it('counts and logs a line result and an exception the platform refuses once the audit is closed', () => {
        platform.refuses = (table, row) => (table === EXCEPTIONS || (table === LINES && row.sys_id === 'scan-XYZ') ? 'no' : '')
        expect(closeAudit(countedAudit())).toEqual({ outcome: 'closed', unsaved: 2 })
        expect(rows(AUDITS)[0]).toMatchObject({ missing_count: '1', unexpected_count: '1', state: '3' })
        expect(resultOf('scan-XYZ')).toBe('found')
        expect(rows(EXCEPTIONS)).toEqual([])
        // The exception refused where it is raised, the missing Asset left without one, and the line left as it was.
        expect(platform.warnings).toEqual([
            expect.stringMatching(/audit_missing.*\ba2\b.*: no$/),
            expect.stringMatching(/\bAUD1\b.*no missing in audit exception for a2\b.*raise it by hand$/),
            expect.stringMatching(/\bAUD1\b.*\bXYZ\b.*unexpected.*: no$/),
        ])
    })

    it('leaves an audit that is not open as it was', () => {
        const audit = countedAudit()
        rows(AUDITS)[0].active = 'false'
        expect(closeAudit(audit)).toEqual({ outcome: 'not_open' })
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
        visit.installed = ['a1', 'a2']
        expect(startSiteAudit(site())).toEqual({ started: true, workOrderOpened: true, number: 'AUD1', expected: 2, leftOff: 0 })
        expect(rows(AUDITS)[0]).toMatchObject({ audit_type: 'site', site: 'site1', customer: 'acme', state: '2', expected_count: '2', work_order: 'wo1' })
        expect(rows(LINES).map((line) => line.asset)).toEqual(['a1', 'a2'])
    })

    it('leaves an Asset the platform refuses off the count, and says when no work order was opened', () => {
        visit.installed = ['a1', 'a2']
        visit.workOrder = null
        platform.refuses = (table, row) => (table === LINES && row.asset === 'a2' ? 'no' : '')
        expect(startSiteAudit(site())).toEqual({ started: true, workOrderOpened: false, number: 'AUD1', expected: 1, leftOff: 1 })
        expect(rows(AUDITS)[0].expected_count).toBe('1')
        // One warning, naming the Asset, the audit and why the platform refused.
        expect(platform.warnings).toEqual([expect.stringMatching(/\ba2\b.*\bAUD1\b.*: no$/)])
    })

    it('says why when what starting set on the audit is not saved: the audit stands', () => {
        visit.installed = ['a1']
        // The audit is inserted; the save of its expected count and work order is refused.
        platform.refuses = (table, _row, operation) => (table === AUDITS && operation === 'update' ? 'read only' : '')
        expect(startSiteAudit(site())).toEqual({ started: true, workOrderOpened: true, number: 'AUD1', expected: 1, leftOff: 0, unsaved: 'read only' })
        expect(rows(AUDITS)[0].expected_count).toBeUndefined()
        // One warning, naming the audit and why the platform refused.
        expect(platform.warnings).toEqual([expect.stringMatching(/\bAUD1\b.*: read only$/)])
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
        // Logged, naming the code and the audit: the client is not sent why.
        expect(platform.warnings).toEqual([expect.stringMatching(/\bFOC222\b.*\bAUD1\b.*: full$/)])
    })
})
