import { gs, type GlideRecord } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { raiseDueAttestations } from '../platform/attestations.ts'
import { closeAudit, findOpenVisibleAudit, recordScan, startSiteAudit, startStockroomAudit } from '../platform/audits.ts'
import { str } from '../platform/records.ts'
import { pathParam, reply, requireScanner, textBodyOf } from '../platform/rest-api.ts'

/** Audits and attestations (P2.7, D63). */

function tellLeftOff(started: { number: string; leftOff: number }): void {
    if (started.leftOff > 0) gs.addErrorMessage(`${started.leftOff} asset(s) left off ${started.number} and not counted (see the system log)`)
}

/**
 * UI action "Start blind count" on a stockroom (platform/audits `startStockroomAudit`). The action is offered on NaaS
 * stockrooms only; one whose type was cleared on a form opened before is refused.
 */
export function uiStartStockroomAudit(current: GlideRecord): void {
    const audit = startStockroomAudit(current)
    if (!audit.started) return void gs.addErrorMessage(`Blind count not started: ${audit.reason}`)
    tellLeftOff(audit)
    gs.addInfoMessage(`Audit ${audit.number} started with ${audit.expected} expected asset(s); scan them in the warehouse app (Audit mode)`)
}

/** UI action "Start site audit" on a site (platform/audits `startSiteAudit`). */
export function uiStartSiteAudit(current: GlideRecord): void {
    const audit = startSiteAudit(current)
    if (!audit.started) return void gs.addErrorMessage(`Site audit not started: ${audit.reason}`)
    tellLeftOff(audit)
    if (!audit.workOrderOpened) gs.addErrorMessage(`No work order for ${audit.number} (see the system log): open one by hand`)
}

/** POST /audits/{id}/scan { code }: record one scan against an open audit the user may see. */
export function scanAudit(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!requireScanner(response)) return
    const audit = findOpenVisibleAudit(pathParam(request, 'id'))
    const code = textBodyOf(request).code ?? ''
    if (!audit) return reply(response, 404, { error: 'No open audit with that number' })
    if (!code) return reply(response, 400, { error: 'code is required' })
    // An unrecorded scan would count its unit missing at close, so the technician is told to scan again.
    const refused = recordScan(audit, code)
    if (refused) return reply(response, 422, { error: `Scan not recorded: ${refused}` })
    reply(response, 200, { audit: str(audit, 'number'), scanned: code })
}

/** UI action "Close audit": compare scans with the expected list; missing assets become exceptions (platform/audits `closeAudit`). */
export function uiCloseAudit(current: GlideRecord): void {
    if (closeAudit(current) === 'not_open') gs.addErrorMessage('Only an open audit of one of your stockrooms can be closed')
}

/** Daily job: open the attestations that are due (platform/attestations `raiseDueAttestations`). */
export function raiseAttestations(): void {
    raiseDueAttestations()
}
