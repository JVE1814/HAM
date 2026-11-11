// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideDateTime, GlideRecord, gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { attestationDue, compareAudit, type ExpectedAsset } from '../domain/audit.ts'
import { fleetStagesQuery, naasStockroomType, STOCKROOM_TYPE_FIELD } from '../domain/fleet.ts'
import { INSTALL_STATUS, type Stage } from '../domain/lifecycle.ts'
import {
    outsideFleetExceptionsQuery,
    reconcileAsset,
    seenWithoutFleetAssetQuery,
    stillSeenWithoutFleetAssetQuery,
    type ExceptionType,
} from '../domain/reconciliation.ts'
import { ROLE, visibilityFilter } from '../domain/visibility.ts'
import { customerAdminIds } from '../platform/approvals.ts'
import { runTableJob } from '../platform/chunked.ts'
import { glideToIsoDate, glideToMs, nowMs, todayIso } from '../platform/clock.ts'
import { openFieldWork } from '../platform/field-work.ts'
import { openException, resolveCiExceptions, resolveExceptions, resolveExceptionsWhere } from '../platform/exceptions.ts'
import { intProperty, PROPERTY } from '../platform/properties.ts'
import { bool, exists, num, pluck, refusal, str } from '../platform/records.ts'
import { installedAssetIds } from '../platform/returns.ts'
import { currentSession } from '../platform/session.ts'

/** Audits, attestations and reconciliation (P2.7, Q63). */

/**
 * The stages of the units on a stockroom's shelves, which its blind count expects there. A unit in transfer is one of
 * them until its transfer order line is In Transit: from Draft to Shipment Preparation Inventory keeps it In stock
 * (Pending transfer) in the stockroom it is sent from, and sets the stockroom it is sent to only once the line is
 * received (ADR 0002, external-contracts N38), so the Asset's stockroom says which shelf it is on. At In Transit it is
 * In transit by install status, on its way and on no shelf, so `onTheShelf` keeps to units In stock by install status,
 * which every other stage here is too.
 */
const ON_THE_SHELF: readonly Stage[] = [
    'available',
    'reserved',
    'spare_pool',
    'staging',
    'staged',
    'pending_evaluation',
    'pending_wipe',
    'pending_disposal',
    'in_transfer',
]

/** The fleet assets on the shelves of the stockroom: In stock by install status, in one of the ON_THE_SHELF stages. */
function onTheShelf(stockroomId: string): string {
    return fleetStagesQuery(ON_THE_SHELF, `stockroom=${stockroomId}^install_status=${INSTALL_STATUS.inStock}`)
}

/**
 * List the Assets a saved audit expects; how many were listed. Close compares scans with the listed ones only, so a
 * line the platform refuses is logged, left out of the count, and the user told.
 */
function listExpected(audit: GlideRecord, assetIds: readonly string[]): number {
    const number = str(audit, 'number')
    let listed = 0
    for (const assetId of assetIds) {
        const line = new GlideRecord('x_daas_ham_audit_line')
        line.initialize()
        line.setValue('audit', audit.getUniqueValue())
        line.setValue('asset', assetId)
        if (line.insert()) listed++
        else gs.warn(`[x_daas_ham] Asset ${assetId} left off audit ${number}: ${refusal(line)}`)
    }
    const left = assetIds.length - listed
    if (left > 0) gs.addErrorMessage(`${left} asset(s) left off ${number} and not counted (see the system log)`)
    return listed
}

/**
 * UI action "Start blind count" on a stockroom: the expected list is every fleet asset on its shelves (`onTheShelf`),
 * a unit on a transfer order line short of In Transit included. A stockroom with no NaaS stockroom type is the
 * Provider IT's (ADR 0016), and is not counted: the action is offered on NaaS stockrooms only, and this refuses one
 * whose type was cleared on a form opened before.
 */
export function uiStartStockroomAudit(current: GlideRecord): void {
    if (!naasStockroomType(str(current, STOCKROOM_TYPE_FIELD))) {
        return void gs.addErrorMessage('Blind count not started: this is not a NaaS stockroom (it has no stockroom type)')
    }
    const audit = new GlideRecord('x_daas_ham_audit')
    audit.initialize()
    audit.setValue('audit_type', 'stockroom')
    audit.setValue('stockroom', current.getUniqueValue())
    audit.setValue('short_description', `Blind count of ${str(current, 'name')}`)
    audit.setValue('state', 2)
    if (!audit.insert()) return void gs.addErrorMessage(`Blind count not started: ${refusal(audit)}`)
    const asset = new GlideRecord('alm_hardware')
    asset.addEncodedQuery(onTheShelf(current.getUniqueValue()))
    asset.query()
    const inStock: string[] = []
    while (asset.next()) inStock.push(asset.getUniqueValue())
    const expected = listExpected(audit, inStock)
    audit.setValue('expected_count', expected)
    if (!audit.update()) notSaved(audit, 'its expected count')
    gs.addInfoMessage(`Audit ${str(audit, 'number')} started with ${expected} expected asset(s); scan them in the warehouse app (Audit mode)`)
}

/**
 * Log, and tell the user, that the platform refused to save `what` on a started audit, and why. The audit stands: close
 * compares the scans with its lines, and the counts and links on the audit only show what it holds.
 */
function notSaved(audit: GlideRecord, what: string): void {
    const reason = refusal(audit)
    gs.warn(`[x_daas_ham] Audit ${str(audit, 'number')} started, ${what} not saved: ${reason}`)
    gs.addErrorMessage(`Audit ${str(audit, 'number')} started, but ${what} was not saved: ${reason}`)
}

/** UI action "Start site audit" on a site: expected = installed fleet assets; an FSM work order sends an engineer. */
export function uiStartSiteAudit(current: GlideRecord): void {
    const audit = new GlideRecord('x_daas_ham_audit')
    audit.initialize()
    audit.setValue('audit_type', 'site')
    audit.setValue('site', current.getUniqueValue())
    audit.setValue('customer', str(current, 'company'))
    audit.setValue('short_description', `Site audit of ${str(current, 'name')}`)
    audit.setValue('state', 2)
    const auditId = audit.insert()
    if (!auditId) return void gs.addErrorMessage(`Site audit not started: ${refusal(audit)}`)
    const expected = listExpected(audit, installedAssetIds({ siteId: current.getUniqueValue() }))
    const context = {
        customerId: str(current, 'company'),
        siteId: current.getUniqueValue(),
        description: `Site audit ${str(audit, 'number')} at ${str(current, 'name')}`,
        source: { field: 'x_daas_ham_audit' as const, id: auditId },
    }
    const work = openFieldWork(context, { changeType: 'standard', purpose: 'site_audit', subcontracted: false })
    audit.setValue('expected_count', expected)
    if (work) audit.setValue('work_order', work.workOrderId)
    else gs.addErrorMessage(`No work order for ${str(audit, 'number')} (see the system log): open one by hand`)
    // The work order names the audit all the same (its source), so it is found from there.
    if (!audit.update()) notSaved(audit, work ? 'its expected count and work order' : 'its expected count')
}

/** POST /audits/{id}/scan { code }: record one scan against an open audit the user may see. */
export function scanAudit(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!gs.hasRole(ROLE.inventoryTech) && !gs.hasRole(ROLE.fieldTech)) {
        response.setStatus(403)
        response.setBody({ error: 'Requires the inventory tech or field tech role' } as never)
        return
    }
    const audit = findOpenVisibleAudit(String(request.pathParams.id ?? ''))
    const code = String((request.body.data as { code?: string } | null)?.code ?? '').trim()
    if (!audit) {
        response.setStatus(404)
        response.setBody({ error: 'No open audit with that number' } as never)
        return
    }
    if (!code) {
        response.setStatus(400)
        response.setBody({ error: 'code is required' } as never)
        return
    }
    const line = new GlideRecord('x_daas_ham_audit_line')
    line.initialize()
    line.setValue('audit', audit.getUniqueValue())
    line.setValue('scanned_code', code)
    line.setValue('result', 'found')
    line.setValue('scanned_at', new GlideDateTime().getValue())
    // An unrecorded scan would count its unit missing at close, so the technician is told to scan again. Why the
    // platform refused it is logged, not sent to the client (as entry/customer).
    if (!line.insert()) {
        gs.warn(`[x_daas_ham] Scan of ${code} on audit ${str(audit, 'number')} not recorded: ${refusal(line)}`)
        response.setStatus(422)
        response.setBody({ error: 'Scan not recorded: the platform refused it; scan it again' } as never)
        return
    }
    response.setStatus(200)
    response.setBody({ audit: str(audit, 'number'), scanned: code } as never)
}

/**
 * The open audit with this sys_id or number, if the user may work on it: an inventory tech only the blind counts
 * of their stockrooms (a site audit has no stockroom), other staff every audit. The audit before-query rule
 * (scopeAudits) already narrows this query the same way; the filter is kept so the check that guards scanning and
 * closing does not depend on that rule being active, and applying it twice changes nothing.
 */
function findOpenVisibleAudit(key: string): GlideRecord | null {
    if (!key) return null
    const session = currentSession()
    const audit = new GlideRecord('x_daas_ham_audit')
    audit.addQuery('sys_id', key).addOrCondition('number', key)
    audit.addActiveQuery()
    const filter = visibilityFilter(session.scope, { stockroom: 'stockroom', customer: 'customer', site: 'site' }, session)
    if (filter) audit.addEncodedQuery(filter)
    audit.setLimit(1)
    audit.query()
    return audit.next() ? audit : null
}

/**
 * UI action "Close audit": compare scans with the expected list; missing assets become exceptions. The audit is closed
 * first: one the platform refuses to close stays open, to scan and close again, with no line marked and no exception
 * raised for a unit that may still be scanned. A line result or exception then refused is logged and counted to the
 * user, to fix by hand: closing does not run again.
 */
export function uiCloseAudit(current: GlideRecord): void {
    if (!findOpenVisibleAudit(current.getUniqueValue())) {
        gs.addErrorMessage('Only an open audit of one of your stockrooms can be closed')
        return
    }
    const expected: ExpectedAsset[] = []
    const scans: string[] = []
    const line = new GlideRecord('x_daas_ham_audit_line')
    line.addQuery('audit', current.getUniqueValue())
    line.query()
    while (line.next()) {
        if (str(line, 'scanned_code')) scans.push(str(line, 'scanned_code'))
        else if (str(line, 'asset')) {
            expected.push({
                assetId: str(line, 'asset'),
                serial: str(line, 'asset.serial_number'),
                providerTag: str(line, 'asset.asset_tag'),
                customerTag: str(line, 'asset.x_daas_ham_customer_tag'),
            })
        }
    }
    const result = compareAudit(expected, scans)
    const number = str(current, 'number')
    current.setValue('matched_count', result.matched.length)
    current.setValue('missing_count', result.missing.length)
    current.setValue('unexpected_count', result.unexpected.length)
    current.setValue('state', 3)
    if (!current.update()) return void gs.addErrorMessage(`Audit ${number} not closed: ${refusal(current)}`)
    let unsaved = 0
    const outcome = new GlideRecord('x_daas_ham_audit_line')
    outcome.addQuery('audit', current.getUniqueValue())
    outcome.addNullQuery('scanned_code')
    outcome.query()
    while (outcome.next()) {
        const missing = result.missing.includes(str(outcome, 'asset'))
        if (!markLine(outcome, missing ? 'missing' : 'found', number)) unsaved++
        if (missing && !raiseMissing(outcome, number)) unsaved++
    }
    const scanned = new GlideRecord('x_daas_ham_audit_line')
    scanned.addQuery('audit', current.getUniqueValue())
    scanned.addNotNullQuery('scanned_code')
    scanned.query()
    while (scanned.next()) {
        if (result.unexpected.includes(str(scanned, 'scanned_code')) && !markLine(scanned, 'unexpected', number)) unsaved++
    }
    if (unsaved > 0) gs.addErrorMessage(`Audit ${number} closed, but ${unsaved} line result(s) or exception(s) were not saved (see the system log)`)
}

/**
 * Raise the *missing in audit* exception of the line's Asset (platform/exceptions `openException`); false, logged, when
 * none is open afterwards, as the closed audit does not raise it again. openException returns nothing: an insert the
 * platform refuses is logged there and returns normally, as does a raise whose lock another holds through every try,
 * and one whose lock cannot be taken throws. So whether the exception stands is read back.
 */
function raiseMissing(line: GlideRecord, number: string): boolean {
    const assetId = str(line, 'asset')
    let why = 'none is open (see the system log)'
    try {
        openException('audit_missing', { assetId, customerId: str(line, 'asset.company'), detail: `Not found in ${number}` })
    } catch (error) {
        why = error instanceof Error ? error.message : String(error)
    }
    if (exists('x_daas_ham_recon_exception', `exception_type=audit_missing^status=open^asset=${assetId}`)) return true
    gs.warn(`[x_daas_ham] Audit ${number}: no missing in audit exception for ${line.getDisplayValue('asset')}: ${why}; raise it by hand`)
    return false
}

/** Save an audit line's result; false when the platform refuses (logged): the audit's counts still have it. */
function markLine(line: GlideRecord, result: 'found' | 'missing' | 'unexpected', number: string): boolean {
    line.setValue('result', result)
    if (line.update()) return true
    const what = str(line, 'scanned_code') || line.getDisplayValue('asset')
    gs.warn(`[x_daas_ham] Audit ${number}: line of ${what} not saved as ${result}: ${refusal(line)}`)
    return false
}

/**
 * Daily: open an attestation for each Site with fleet assets of an attesting Agreement, once none is open there and
 * the last one was attested longer ago than the Agreement's interval (or never). One attestation covers every fleet
 * asset installed at the Site, so a Site that several Agreements serve follows the shortest of their intervals; the
 * attestation records the Agreement whose interval raised it.
 */
export function raiseAttestations(): void {
    const today = todayIso()
    const agreement = new GlideRecord('x_daas_ham_agreement')
    agreement.addQuery('state', 'active')
    agreement.addQuery('attestation_interval_months', '>', 0)
    agreement.query()
    while (agreement.next()) {
        const sites = new Set<string>()
        const asset = new GlideRecord('alm_hardware')
        asset.addEncodedQuery(fleetStagesQuery(['in_service', 'temporary_deployment'], `x_daas_ham_agreement=${agreement.getUniqueValue()}`))
        asset.query()
        while (asset.next()) if (str(asset, 'x_daas_ham_site')) sites.add(str(asset, 'x_daas_ham_site'))
        for (const siteId of sites) {
            if (exists('x_daas_ham_attestation', `site=${siteId}^active=true`)) continue
            const last = lastAttestedOn(siteId)
            if (!attestationDue({ lastAttestedOn: last, intervalMonths: num(agreement, 'attestation_interval_months'), today })) continue
            openAttestation(agreement, siteId)
        }
    }
}

function lastAttestedOn(siteId: string): string | undefined {
    const last = new GlideRecord('x_daas_ham_attestation')
    last.addQuery('site', siteId)
    last.addNotNullQuery('attested_at')
    last.orderByDesc('attested_at')
    last.setLimit(1)
    last.query()
    return last.next() ? glideToIsoDate(str(last, 'attested_at')) : undefined
}

/** The task states an attestation takes: pending while its Assets are listed, open to answer, closed once attested. */
const ATTESTATION_STATE = { pending: -5, open: 1, closed: 3 } as const

/**
 * Raise the Site's attestation, pending until every installed Asset is listed on it: submitted without one, it would
 * confirm the Site without that Asset. One whose item (or opening) the platform refuses is removed with its items, so
 * none is open and the next run raises it whole; one the platform keeps stays pending, never closed, to cancel.
 */
function openAttestation(agreement: GlideRecord, siteId: string): void {
    const customerId = str(agreement, 'customer')
    const attestation = new GlideRecord('x_daas_ham_attestation')
    attestation.initialize()
    attestation.setValue('customer', customerId)
    attestation.setValue('site', siteId)
    attestation.setValue('agreement', agreement.getUniqueValue())
    attestation.setValue('assigned_to', customerAdminIds(customerId)[0] ?? '')
    attestation.setValue('short_description', 'Confirm the equipment installed at your site')
    attestation.setValue('state', ATTESTATION_STATE.pending)
    const attestationId = attestation.insert()
    // Refused: none is open at the Site, so the next run raises it again.
    if (!attestationId) return void gs.warn(`[x_daas_ham] No attestation for site ${siteId}: ${refusal(attestation)}`)
    let why = listAttested(attestationId, installedAssetIds({ siteId }))
    if (!why) {
        attestation.setValue('state', ATTESTATION_STATE.open)
        if (attestation.update()) return
        why = `not opened: ${refusal(attestation)}`
    }
    const kept = attestation.deleteRecord() ? '' : `; ${str(attestation, 'number')} stays pending, cancel it`
    gs.warn(`[x_daas_ham] No attestation for site ${siteId}: ${why}${kept}`)
}

/** List each Asset on the attestation; why the platform refused the first one it left off ('' when all are listed). */
function listAttested(attestationId: string, assetIds: readonly string[]): string {
    for (const assetId of assetIds) {
        const item = new GlideRecord('x_daas_ham_attestation_item')
        item.initialize()
        item.setValue('attestation', attestationId)
        item.setValue('asset', assetId)
        if (!item.insert()) return `asset ${assetId} not listed: ${refusal(item)}`
    }
    return ''
}

/**
 * Close an attestation answered by the customer; assets reported missing become exceptions. Why it was not closed
 * ('' once closed): one still pending, or cancelled as one left pending is (openAttestation), may not list every
 * installed Asset, and one the platform refuses to close stays open to submit again, which raises no exception twice
 * (openException).
 */
export function completeAttestation(attestation: GlideRecord): string {
    const number = str(attestation, 'number')
    if (num(attestation, 'state') === ATTESTATION_STATE.pending) return notClosed(number, 'it may not list every asset')
    if (!bool(attestation, 'active')) return notClosed(number, 'it is closed')
    const item = new GlideRecord('x_daas_ham_attestation_item')
    item.addQuery('attestation', attestation.getUniqueValue())
    item.addQuery('response', 'missing')
    item.query()
    while (item.next()) {
        openException('attested_missing', {
            assetId: str(item, 'asset'),
            customerId: str(attestation, 'customer'),
            detail: `Reported not present in ${number}`,
        })
    }
    attestation.setValue('attested_by', gs.getUserID())
    attestation.setValue('attested_at', new GlideDateTime().getValue())
    attestation.setValue('state', ATTESTATION_STATE.closed)
    return attestation.update() ? '' : notClosed(number, refusal(attestation))
}

function notClosed(number: string, reason: string): string {
    gs.warn(`[x_daas_ham] Attestation ${number} not closed: ${reason}`)
    return reason
}

const MONITORING_TYPES: readonly ExceptionType[] = ['unseen', 'serial_mismatch', 'location_mismatch']

/**
 * Daily: compare installed fleet assets with monitoring; open new exceptions and resolve cleared ones. The Provider
 * IT's equipment in use (laptops, printers) is in service by its install status too, and is left out (ADR 0016): a
 * monitoring exception open on an Asset outside the fleet (raised before the Fleet flag) is resolved, as is a *seen
 * without asset* one whose CI no longer matches.
 */
export function reconcileInstalledBase(): void {
    const unseenDays = intProperty(PROPERTY.unseenDays, 7)
    const now = nowMs()
    runTableJob({
        job: 'reconcile_installed_base',
        table: 'alm_hardware',
        query: fleetStagesQuery(['in_service', 'temporary_deployment']),
        read: (asset) => ({
            customerId: str(asset, 'company'),
            view: {
                serial: str(asset, 'serial_number'),
                siteId: str(asset, 'x_daas_ham_site'),
                lastSeenAt: glideToMs(str(asset, 'x_daas_ham_last_seen')),
                ci: str(asset, 'ci')
                    ? {
                          serial: str(asset, 'ci.serial_number'),
                          locationIds: [str(asset, 'ci.location'), str(asset, 'ci.location.parent'), str(asset, 'ci.location.parent.parent')],
                      }
                    : undefined,
            },
        }),
        handle: (asset, assetId) => {
            const found = reconcileAsset(asset.view, now, unseenDays)
            for (const type of found) openException(type, { assetId, customerId: asset.customerId, detail: type.replace(/_/g, ' ') })
            resolveExceptions(assetId, MONITORING_TYPES.filter((type) => !found.includes(type)))
        },
    })
    resolveExceptionsWhere(outsideFleetExceptionsQuery(MONITORING_TYPES))
    resolveClearedSeenWithoutAsset()
    reportSeenWithoutAsset(unseenDays)
}

/**
 * Resolve the open *seen without asset* exceptions whose CI `stillSeenWithoutFleetAssetQuery` leaves out: it points at a
 * fleet asset now, is not at a customer Site (the Provider IT's own gear, reported before the Fleet flag), or is gone.
 */
function resolveClearedSeenWithoutAsset(): void {
    const reported = pluck('x_daas_ham_recon_exception', 'status=open^exception_type=seen_without_asset^ciISNOTEMPTY', 'ci')
    const query = stillSeenWithoutFleetAssetQuery(reported)
    if (!query) return
    const still = new Set(pluck('cmdb_ci_netgear', query, 'sys_id'))
    for (const ciId of new Set(reported)) if (!still.has(ciId)) resolveCiExceptions(ciId, ['seen_without_asset'])
}

/** Network CIs recently discovered at a customer Site that no fleet asset points at (`seenWithoutFleetAssetQuery`). */
function reportSeenWithoutAsset(days: number): void {
    const since = new GlideDateTime()
    since.addDaysUTC(-days)
    const ci = new GlideRecord('cmdb_ci_netgear')
    ci.addQuery('last_discovered', '>=', since.getValue())
    ci.addEncodedQuery(seenWithoutFleetAssetQuery())
    ci.setLimit(1000)
    ci.query()
    while (ci.next()) {
        openException('seen_without_asset', {
            ciId: ci.getUniqueValue(),
            customerId: str(ci, 'company'),
            detail: `${str(ci, 'name')} (${str(ci, 'serial_number')}) is monitored at a Site but is no fleet asset`,
        })
    }
}
