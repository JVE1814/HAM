// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideDateTime, GlideRecord, gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { attestationDue, compareAudit, type ExpectedAsset } from '../domain/audit'
import { stagesQuery, type Stage } from '../domain/lifecycle'
import { reconcileAsset, type ExceptionType } from '../domain/reconciliation'
import { ROLE, visibilityFilter } from '../domain/visibility'
import { customerAdminIds } from '../platform/approvals'
import { runTableJob } from '../platform/chunked'
import { glideToIsoDate, glideToMs, nowMs, todayIso } from '../platform/clock'
import { openChange, openWorkOrder } from '../platform/field-work'
import { openException, resolveExceptions } from '../platform/exceptions'
import { intProperty, PROPERTY } from '../platform/properties'
import { exists, num, str } from '../platform/records'
import { installedAssetIds } from '../platform/returns'
import { currentSession } from '../platform/session'

/** Audits, attestations and reconciliation (P2.7, D63). */

const IN_STOCK_STAGES: readonly Stage[] = ['available', 'reserved', 'spare_pool', 'staging', 'staged', 'pending_evaluation', 'pending_wipe', 'pending_disposal']

function expectedLine(auditId: string, assetId: string): void {
    const line = new GlideRecord('x_daas_ham_audit_line')
    line.initialize()
    line.setValue('audit', auditId)
    line.setValue('asset', assetId)
    line.insert()
}

/** UI action "Start blind count" on a stockroom: the expected list is everything in stock there. */
export function uiStartStockroomAudit(current: GlideRecord): void {
    const audit = new GlideRecord('x_daas_ham_audit')
    audit.initialize()
    audit.setValue('audit_type', 'stockroom')
    audit.setValue('stockroom', current.getUniqueValue())
    audit.setValue('short_description', `Blind count of ${str(current, 'name')}`)
    audit.setValue('state', 2)
    const auditId = audit.insert() ?? ''
    const asset = new GlideRecord('alm_hardware')
    asset.addEncodedQuery(stagesQuery(IN_STOCK_STAGES, `stockroom=${current.getUniqueValue()}`))
    asset.query()
    let expected = 0
    while (asset.next()) {
        expectedLine(auditId, asset.getUniqueValue())
        expected++
    }
    audit.setValue('expected_count', expected)
    audit.update()
    gs.addInfoMessage(`Audit ${str(audit, 'number')} started with ${expected} expected asset(s); scan them in the warehouse app (Audit mode)`)
}

/** UI action "Start site audit" on a site: expected = installed assets; an FSM work order sends an engineer. */
export function uiStartSiteAudit(current: GlideRecord): void {
    const audit = new GlideRecord('x_daas_ham_audit')
    audit.initialize()
    audit.setValue('audit_type', 'site')
    audit.setValue('site', current.getUniqueValue())
    audit.setValue('customer', str(current, 'company'))
    audit.setValue('short_description', `Site audit of ${str(current, 'name')}`)
    audit.setValue('state', 2)
    const auditId = audit.insert() ?? ''
    const assets = installedAssetIds({ siteId: current.getUniqueValue() })
    for (const assetId of assets) expectedLine(auditId, assetId)
    const context = {
        customerId: str(current, 'company'),
        siteId: current.getUniqueValue(),
        description: `Site audit ${str(audit, 'number')} at ${str(current, 'name')}`,
        source: { field: 'x_daas_ham_audit' as const, id: auditId },
    }
    audit.setValue('expected_count', assets.length)
    audit.setValue('work_order', openWorkOrder(context, 'site_audit', openChange(context, 'standard'), false))
    audit.update()
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
    line.insert()
    response.setStatus(200)
    response.setBody({ audit: str(audit, 'number'), scanned: code } as never)
}

/**
 * The open audit with this sys_id or number, if the user may work on it: an inventory tech only the blind counts
 * of their stockrooms (a site audit has no stockroom), other staff every audit. The audit before-query rule
 * (scopeAudits) already narrows this query the same way; the filter is repeated here because scanning and closing
 * rely on it, and adding it twice changes nothing.
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

/** UI action "Close audit": compare scans with the expected list; missing assets become exceptions. */
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
    const outcome = new GlideRecord('x_daas_ham_audit_line')
    outcome.addQuery('audit', current.getUniqueValue())
    outcome.addNullQuery('scanned_code')
    outcome.query()
    while (outcome.next()) {
        const missing = result.missing.includes(str(outcome, 'asset'))
        outcome.setValue('result', missing ? 'missing' : 'found')
        outcome.update()
        if (missing) {
            openException('audit_missing', {
                assetId: str(outcome, 'asset'),
                customerId: str(outcome, 'asset.company'),
                detail: `Not found in ${str(current, 'number')}`,
            })
        }
    }
    const scanned = new GlideRecord('x_daas_ham_audit_line')
    scanned.addQuery('audit', current.getUniqueValue())
    scanned.addNotNullQuery('scanned_code')
    scanned.query()
    while (scanned.next()) {
        if (!result.unexpected.includes(str(scanned, 'scanned_code'))) continue
        scanned.setValue('result', 'unexpected')
        scanned.update()
    }
    current.setValue('matched_count', result.matched.length)
    current.setValue('missing_count', result.missing.length)
    current.setValue('unexpected_count', result.unexpected.length)
    current.setValue('state', 3)
    current.update()
}

/**
 * Daily: open an attestation for each Site with Assets of an attesting Agreement, once none is open there and the
 * last one was attested longer ago than the Agreement's interval (or never). One attestation covers every Asset
 * installed at the Site, so a Site that several Agreements serve follows the shortest of their intervals; the
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
        asset.addEncodedQuery(stagesQuery(['in_service', 'temporary_deployment'], `x_daas_ham_agreement=${agreement.getUniqueValue()}`))
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

function openAttestation(agreement: GlideRecord, siteId: string): void {
    const customerId = str(agreement, 'customer')
    const attestation = new GlideRecord('x_daas_ham_attestation')
    attestation.initialize()
    attestation.setValue('customer', customerId)
    attestation.setValue('site', siteId)
    attestation.setValue('agreement', agreement.getUniqueValue())
    attestation.setValue('assigned_to', customerAdminIds(customerId)[0] ?? '')
    attestation.setValue('short_description', 'Confirm the equipment installed at your site')
    attestation.setValue('state', 1)
    const attestationId = attestation.insert() ?? ''
    for (const assetId of installedAssetIds({ siteId })) {
        const item = new GlideRecord('x_daas_ham_attestation_item')
        item.initialize()
        item.setValue('attestation', attestationId)
        item.setValue('asset', assetId)
        item.insert()
    }
}

/** Close an attestation answered by the customer; assets reported missing become exceptions. */
export function completeAttestation(attestation: GlideRecord): void {
    const item = new GlideRecord('x_daas_ham_attestation_item')
    item.addQuery('attestation', attestation.getUniqueValue())
    item.addQuery('response', 'missing')
    item.query()
    while (item.next()) {
        openException('attested_missing', {
            assetId: str(item, 'asset'),
            customerId: str(attestation, 'customer'),
            detail: `Reported not present in ${str(attestation, 'number')}`,
        })
    }
    attestation.setValue('attested_by', gs.getUserID())
    attestation.setValue('attested_at', new GlideDateTime().getValue())
    attestation.setValue('state', 3)
    attestation.update()
}

const MONITORING_TYPES: readonly ExceptionType[] = ['unseen', 'serial_mismatch', 'location_mismatch']

/** Daily: compare installed assets with monitoring; open new exceptions and resolve cleared ones. */
export function reconcileInstalledBase(): void {
    const unseenDays = intProperty(PROPERTY.unseenDays, 7)
    const now = nowMs()
    runTableJob({
        job: 'reconcile_installed_base',
        table: 'alm_hardware',
        query: stagesQuery(['in_service', 'temporary_deployment']),
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
    reportSeenWithoutAsset(unseenDays)
}

/** Network CIs recently discovered that no asset points at. */
function reportSeenWithoutAsset(days: number): void {
    const since = new GlideDateTime()
    since.addDaysUTC(-days)
    const ci = new GlideRecord('cmdb_ci_netgear')
    ci.addQuery('last_discovered', '>=', since.getValue())
    ci.addNullQuery('asset')
    ci.setLimit(1000)
    ci.query()
    while (ci.next()) {
        openException('seen_without_asset', {
            ciId: ci.getUniqueValue(),
            customerId: str(ci, 'company'),
            detail: `${str(ci, 'name')} (${str(ci, 'serial_number')}) is monitored but has no asset`,
        })
    }
}
