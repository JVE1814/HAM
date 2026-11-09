import { GlideRecord } from '@servicenow/glide'
import { AUDIT_STATE, closedLineResult, compareAudit, onTheShelfQuery, type ExpectedAsset } from '../domain/audit.ts'
import { naasStockroomType, STOCKROOM_TYPE_FIELD } from '../domain/fleet.ts'
import { SCOPED_TABLES, visibilityFilter } from '../domain/visibility.ts'
import type { AuditType } from '../domain/vocabulary.ts'
import { nowGlide } from './clock.ts'
import { openException } from './exceptions.ts'
import { openFieldWork } from './field-work.ts'
import { refusal, str, warnRefused } from './records.ts'
import { installedAssetIds } from './installed-assets.ts'
import { currentSession } from './session.ts'

/**
 * Audits: a stockroom's blind count and a Site's audit (P2.7, D63). An audit is started with the list of Assets it
 * expects, scans are recorded against it while it is open, and closing it compares the two. None of it tells the user
 * anything: each gives what came of it, for the trigger that asked to report.
 */

const AUDIT = 'x_daas_ham_audit'
const LINE = 'x_daas_ham_audit_line'

/** An audit that was started: its number, and how many Assets it expects and could not list. */
interface StartedAudit {
    number: string
    /** The Assets listed, which close compares the scans with. */
    expected: number
    /** The Assets the platform refused to list (each logged): they are not counted. */
    leftOff: number
}

export type AuditStart = ({ started: true } & StartedAudit) | { started: false; reason: string }

/** A Site audit that was started, and whether a work order sends an engineer to do it. */
export type SiteAuditStart = ({ started: true; workOrderOpened: boolean } & StartedAudit) | { started: false; reason: string }

/** A new audit in progress, not yet saved. */
function newAudit(type: AuditType, shortDescription: string): GlideRecord {
    const audit = new GlideRecord(AUDIT)
    audit.initialize()
    audit.setValue('audit_type', type)
    audit.setValue('short_description', shortDescription)
    audit.setValue('state', AUDIT_STATE.inProgress)
    return audit
}

/**
 * List the Assets a saved audit expects, and set how many were listed on it (`saveStarted` saves that). Close compares
 * scans with the listed ones only, so a line the platform refuses is logged and left out of the count.
 */
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

/** Save what starting the audit set on it; a refused save is logged, and the audit stays open without it. */
function saveStarted(audit: GlideRecord, started: StartedAudit): void {
    if (!audit.update()) warnRefused(audit, `Audit ${started.number} not given its expected count of ${started.expected}`)
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
    const started = listExpected(audit, onTheShelf)
    saveStarted(audit, started)
    return { started: true, ...started }
}

/** Start the audit of a Site: it expects the fleet assets installed there, and an FSM work order sends an engineer. */
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
    saveStarted(audit, started)
    return { started: true, workOrderOpened: !!work, ...started }
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

/** Record one scan against an open audit; why the platform refused it ('' once recorded). */
export function recordScan(audit: GlideRecord, code: string): string {
    const line = new GlideRecord(LINE)
    line.initialize()
    line.setValue('audit', audit.getUniqueValue())
    line.setValue('scanned_code', code)
    line.setValue('result', 'found')
    line.setValue('scanned_at', nowGlide())
    return line.insert() ? '' : refusal(line)
}

/** How closing an audit ended: `not_open` when it is no open audit the user may work on, and nothing was changed. */
export type AuditClose = 'closed' | 'not_open' | 'not_saved'

/**
 * Close an audit: compare its scans with its expected list (domain/audit `compareAudit`), give each line its result,
 * raise an exception for each Asset missing, and save the counts on the audit. The lines are read once to compare and
 * once to write. A line the platform refuses keeps its earlier result and is logged, as is an audit it refuses to
 * close, which stays open to close again (no exception is raised twice: platform/exceptions `openException`).
 */
export function closeAudit(audit: GlideRecord): AuditClose {
    const auditId = audit.getUniqueValue()
    if (!findOpenVisibleAudit(auditId)) return 'not_open'
    const number = str(audit, 'number')
    const expected: ExpectedAsset[] = []
    const scans: string[] = []
    const read = new GlideRecord(LINE)
    read.addQuery('audit', auditId)
    read.query()
    while (read.next()) {
        if (str(read, 'scanned_code')) scans.push(str(read, 'scanned_code'))
        else if (str(read, 'asset')) {
            expected.push({
                assetId: str(read, 'asset'),
                serial: str(read, 'asset.serial_number'),
                providerTag: str(read, 'asset.asset_tag'),
                customerTag: str(read, 'asset.x_daas_ham_customer_tag'),
            })
        }
    }
    const comparison = compareAudit(expected, scans)
    const line = new GlideRecord(LINE)
    line.addQuery('audit', auditId)
    line.query()
    while (line.next()) {
        const assetId = str(line, 'asset')
        const scannedCode = str(line, 'scanned_code')
        const result = closedLineResult({ assetId, scannedCode }, comparison)
        if (!result) continue
        line.setValue('result', result)
        if (!line.update()) warnRefused(line, `Audit ${number}: ${scannedCode || assetId} not marked ${result}`)
        if (result === 'missing') {
            openException('audit_missing', { assetId }, { customerId: str(line, 'asset.company'), detail: `Not found in ${number}` })
        }
    }
    audit.setValue('matched_count', comparison.matched.length)
    audit.setValue('missing_count', comparison.missing.length)
    audit.setValue('unexpected_count', comparison.unexpected.length)
    audit.setValue('state', AUDIT_STATE.closed)
    if (audit.update()) return 'closed'
    warnRefused(audit, `Audit ${number} not closed`)
    return 'not_saved'
}
