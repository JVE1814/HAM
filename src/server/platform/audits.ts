import { GlideRecord } from '@servicenow/glide'
import { IDENTIFIER_FIELDS, type IdentifierColumn } from '../domain/asset-identifier.ts'
import { AUDIT_STATE, closedLineResult, compareAudit, onTheShelfQuery, type ExpectedAsset } from '../domain/audit.ts'
import { messageOf } from '../domain/errors.ts'
import { naasStockroomType, STOCKROOM_TYPE_FIELD } from '../domain/fleet.ts'
import { LOCK } from '../domain/lock-names.ts'
import { SCOPED_TABLES, visibilityFilter } from '../domain/visibility.ts'
import type { AuditLineResult, AuditType } from '../domain/vocabulary.ts'
import { nowGlide } from './clock.ts'
import { openException } from './exceptions.ts'
import { openFieldWork } from './field-work.ts'
import { withLockTries } from './locks.ts'
import { refusal, str, warnRefused } from './records.ts'
import { installedAssetIds } from './installed-assets.ts'
import { currentSession } from './session.ts'
import { log } from './log.ts'

/**
 * Audits: a stockroom's blind count and a Site's audit (P2.7, Q63). An audit is started with the list of Assets it
 * expects, scans are recorded against it while it is open, and closing it compares the two. None of it tells the user
 * anything: each gives what came of it, for the trigger that asked to report.
 */

const AUDIT = 'x_daas_ham_audit'
const LINE = 'x_daas_ham_audit_line'

interface StartedAudit {
    number: string
    /** The Assets listed, which close compares the scans with. */
    expected: number
    /** The Assets the platform refused to list (each logged): they are not counted. */
    leftOff: number
    /**
     * Why the platform refused to save what starting set on the audit (its expected count, and its work order), when it
     * did (logged). The audit stands: close compares the scans with its lines, and the counts and links on the audit
     * only show what it holds.
     */
    unsaved?: string
}

type AuditStart = ({ started: true } & StartedAudit) | { started: false; reason: string }

type SiteAuditStart = ({ started: true; workOrderOpened: boolean } & StartedAudit) | { started: false; reason: string }

function newAudit(type: AuditType, shortDescription: string): GlideRecord {
    const audit = new GlideRecord(AUDIT)
    audit.initialize()
    audit.setValue('audit_type', type)
    audit.setValue('short_description', shortDescription)
    audit.setValue('state', AUDIT_STATE.inProgress)
    return audit
}

function listExpected(audit: GlideRecord, assetIds: readonly string[]): StartedAudit {
    const number = str(audit, 'number')
    let expected = 0
    for (const assetId of assetIds) {
        const line = new GlideRecord(LINE)
        line.initialize()
        line.setValue('audit', audit.getUniqueValue())
        line.setValue('asset', assetId)
        if (line.insert()) expected++
        else warnRefused(line, `Asset ${assetId} left off audit ${number}`)
    }
    audit.setValue('expected_count', expected)
    return { number, expected, leftOff: assetIds.length - expected }
}

function saveStarted(audit: GlideRecord, started: StartedAudit): StartedAudit {
    if (audit.update()) return started
    return { ...started, unsaved: warnRefused(audit, `Audit ${started.number} not given its expected count of ${started.expected}`) }
}

/**
 * Start the blind count of a stockroom: the expected list is every fleet asset on its shelves (domain/audit
 * `onTheShelfQuery`), a unit on a transfer order line short of In Transit included. A stockroom with no NaaS stockroom
 * type is the Provider IT's (ADR 0016), and is not counted.
 */
export function startStockroomAudit(stockroom: GlideRecord): AuditStart {
    if (!naasStockroomType(str(stockroom, STOCKROOM_TYPE_FIELD))) {
        return { started: false, reason: 'this is not a NaaS stockroom (it has no stockroom type)' }
    }
    const audit = newAudit('stockroom', `Blind count of ${str(stockroom, 'name')}`)
    audit.setValue('stockroom', stockroom.getUniqueValue())
    if (!audit.insert()) return { started: false, reason: refusal(audit) }
    const asset = new GlideRecord('alm_hardware')
    asset.addEncodedQuery(onTheShelfQuery(stockroom.getUniqueValue()))
    asset.query()
    const onTheShelf: string[] = []
    while (asset.next()) onTheShelf.push(asset.getUniqueValue())
    return { started: true, ...saveStarted(audit, listExpected(audit, onTheShelf)) }
}

export function startSiteAudit(site: GlideRecord): SiteAuditStart {
    const siteId = site.getUniqueValue()
    const audit = newAudit('site', `Site audit of ${str(site, 'name')}`)
    audit.setValue('site', siteId)
    audit.setValue('customer', str(site, 'company'))
    const auditId = audit.insert()
    if (!auditId) return { started: false, reason: refusal(audit) }
    const started = listExpected(audit, installedAssetIds({ siteId }))
    const context = {
        customerId: str(site, 'company'),
        siteId,
        description: `Site audit ${started.number} at ${str(site, 'name')}`,
        sourceId: auditId,
    }
    const work = openFieldWork(context, { changeType: 'standard', purpose: 'site_audit', subcontracted: false })
    if (work) audit.setValue('work_order', work.workOrderId)
    return { started: true, workOrderOpened: !!work, ...saveStarted(audit, started) }
}

/**
 * The open audit with this sys_id or number, if the user may work on it: an inventory tech only the blind counts
 * of their stockrooms (a site audit has no stockroom), other staff every audit. The audit before-query rule
 * (scopeRecords) already narrows this query the same way; the filter is kept so the check that guards scanning and
 * closing does not depend on that rule being active, and applying it twice changes nothing.
 */
export function findOpenVisibleAudit(key: string): GlideRecord | null {
    if (!key) return null
    const session = currentSession()
    const audit = new GlideRecord(AUDIT)
    audit.addQuery('sys_id', key).addOrCondition('number', key)
    audit.addActiveQuery()
    const filter = visibilityFilter(session.scope, SCOPED_TABLES.x_daas_ham_audit, session)
    if (filter) audit.addEncodedQuery(filter)
    audit.setLimit(1)
    audit.query()
    return audit.next() ? audit : null
}

/**
 * What came of a scan: `recorded`; `not_open` when the audit closed since it was found; `busy` when its close (or
 * another scan) held its lock through every try; `refused` by the platform (logged).
 */
type ScanRecord = 'recorded' | 'not_open' | 'busy' | 'refused'

/** Record one scan against an open audit, under the audit's lock, which its close takes too. */
export function recordScan(audit: GlideRecord, code: string): ScanRecord {
    const auditId = audit.getUniqueValue()
    const run = withLockTries(LOCK.audit(auditId), (): ScanRecord => {
        if (!findOpenVisibleAudit(auditId)) return 'not_open'
        const line = new GlideRecord(LINE)
        line.initialize()
        line.setValue('audit', auditId)
        line.setValue('scanned_code', code)
        const found: AuditLineResult = 'found'
        line.setValue('result', found)
        line.setValue('scanned_at', nowGlide())
        if (line.insert()) return 'recorded'
        warnRefused(line, `Scan of ${code} on audit ${str(audit, 'number')} not recorded`)
        return 'refused'
    })
    return run.ran ? run.value : 'busy'
}

/**
 * How closing an audit ended: `not_open` when it is no open audit the user may work on, and `busy` when a scan held
 * its lock through every try, nothing changed either way; `not_saved` when the platform refused to close it, and why;
 * else `closed`, with how many line results and exceptions the platform refused (`unsaved`, each logged), to fix by
 * hand.
 */
type AuditClose =
    | { outcome: 'not_open' }
    | { outcome: 'busy' }
    | { outcome: 'not_saved'; reason: string }
    | { outcome: 'closed'; unsaved: number }

/**
 * Close an audit: compare its scans with its expected list (domain/audit `compareAudit`), save the counts on the audit,
 * give each line its result and raise an exception for each Asset missing. The lines are read once to compare and once
 * to write. The audit is closed first: one the platform refuses to close stays open, to scan and close again, with no
 * line marked and no exception raised for a unit that may still be scanned. A line result or exception then refused is
 * logged and counted, to fix by hand: closing does not run again. It all runs under the audit's lock, so no scan is
 * recorded between the read of the lines and the close.
 */
export function closeAudit(audit: GlideRecord): AuditClose {
    const run = withLockTries(LOCK.audit(audit.getUniqueValue()), () => closeHolding(audit))
    return run.ran ? run.value : { outcome: 'busy' }
}

function closeHolding(audit: GlideRecord): AuditClose {
    const auditId = audit.getUniqueValue()
    if (!findOpenVisibleAudit(auditId)) return { outcome: 'not_open' }
    const number = str(audit, 'number')
    const expected: ExpectedAsset[] = []
    const scans: string[] = []
    const read = new GlideRecord(LINE)
    read.addQuery('audit', auditId)
    read.query()
    while (read.next()) {
        if (str(read, 'scanned_code')) scans.push(str(read, 'scanned_code'))
        else if (str(read, 'asset')) {
            const codes = Object.fromEntries(IDENTIFIER_FIELDS.map(({ field }) => [field, str(read, `asset.${field}`)]))
            expected.push({ assetId: str(read, 'asset'), ...(codes as Record<IdentifierColumn, string>) })
        }
    }
    const comparison = compareAudit(expected, scans)
    audit.setValue('matched_count', comparison.matched.length)
    audit.setValue('missing_count', comparison.missing.length)
    audit.setValue('unexpected_count', comparison.unexpected.length)
    audit.setValue('state', AUDIT_STATE.closed)
    if (!audit.update()) return { outcome: 'not_saved', reason: warnRefused(audit, `Audit ${number} not closed`) }
    let unsaved = 0
    const line = new GlideRecord(LINE)
    line.addQuery('audit', auditId)
    line.query()
    while (line.next()) {
        const assetId = str(line, 'asset')
        const scannedCode = str(line, 'scanned_code')
        const result = closedLineResult({ assetId, scannedCode }, comparison)
        if (!result) continue
        line.setValue('result', result)
        if (!line.update()) {
            warnRefused(line, `Audit ${number}: ${scannedCode || assetId} not marked ${result}`)
            unsaved++
        }
        if (result === 'missing' && !raiseMissing(line, number)) unsaved++
    }
    return { outcome: 'closed', unsaved }
}

/**
 * Raise the *missing in audit* exception of the line's Asset (platform/exceptions `openException`); false, logged, when
 * none is open afterwards, as the closed audit does not raise it again. A raise whose lock cannot be taken throws, and
 * is logged as one that left none open, so the other lines are still closed.
 */
function raiseMissing(line: GlideRecord, number: string): boolean {
    const assetId = str(line, 'asset')
    let why = 'none is open (see the system log)'
    try {
        if (openException('audit_missing', { assetId }, { customerId: str(line, 'asset.company'), detail: `Not found in ${number}` }) === 'open') return true
    } catch (error) {
        why = messageOf(error)
    }
    log.warn(`Audit ${number}: no missing in audit exception for ${line.getDisplayValue('asset')}: ${why}; raise it by hand`)
    return false
}
