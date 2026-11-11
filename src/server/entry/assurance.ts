import { gs, type GlideRecord } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { raiseDueAttestations } from '../platform/attestations.ts'
import { closeAudit, findOpenVisibleAudit, recordScan, startSiteAudit, startStockroomAudit } from '../platform/audits.ts'
import { str } from '../platform/records.ts'
import { pathParam, reply, requireScanner, textBodyOf } from '../platform/rest-api.ts'

/** Audits and attestations (P2.7, Q63). */

function tellLeftOff(started: { number: string; leftOff: number }): void {
    if (started.leftOff > 0) gs.addErrorMessage(`${started.leftOff} asset(s) left off ${started.number} and not counted (see the system log)`)
}

function tellUnsaved(started: { number: string; unsaved?: string }, what: string): void {
    if (started.unsaved) gs.addErrorMessage(`Audit ${started.number} started, but ${what} was not saved: ${started.unsaved}`)
}

/**
 * UI action "Start blind count" on a stockroom (platform/audits `startStockroomAudit`). The action is offered on NaaS
 * stockrooms only; one whose type was cleared on a form opened before is refused.
 */
export function uiStartStockroomAudit(current: GlideRecord): void {
    const audit = startStockroomAudit(current)
    if (!audit.started) return void gs.addErrorMessage(`Blind count not started: ${audit.reason}`)
    tellLeftOff(audit)
    tellUnsaved(audit, 'its expected count')
    gs.addInfoMessage(`Audit ${audit.number} started with ${audit.expected} expected asset(s); scan them in the warehouse app (Audit mode)`)
}

export function uiStartSiteAudit(current: GlideRecord): void {
    const audit = startSiteAudit(current)
    if (!audit.started) return void gs.addErrorMessage(`Site audit not started: ${audit.reason}`)
    tellLeftOff(audit)
    if (!audit.workOrderOpened) gs.addErrorMessage(`No work order for ${audit.number} (see the system log): open one by hand`)
    tellUnsaved(audit, audit.workOrderOpened ? 'its expected count and work order' : 'its expected count')
}

export function scanAudit(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!requireScanner(response)) return
    const audit = findOpenVisibleAudit(pathParam(request, 'id'))
    const code = textBodyOf(request).code ?? ''
    if (!audit) return reply(response, 404, { error: 'No open audit with that number' })
    if (!code) return reply(response, 400, { error: 'code is required' })
    if (recordScan(audit, code)) return reply(response, 422, { error: 'Scan not recorded: the platform refused it; scan it again' })
    reply(response, 200, { audit: str(audit, 'number'), scanned: code })
}

export function uiCloseAudit(current: GlideRecord): void {
    const number = str(current, 'number')
    const close = closeAudit(current)
    if (close.outcome === 'not_open') return void gs.addErrorMessage('Only an open audit of one of your stockrooms can be closed')
    if (close.outcome === 'not_saved') return void gs.addErrorMessage(`Audit ${number} not closed: ${close.reason}`)
    if (close.unsaved > 0) gs.addErrorMessage(`Audit ${number} closed, but ${close.unsaved} line result(s) or exception(s) were not saved (see the system log)`)
}

export function raiseAttestations(): void {
    raiseDueAttestations()
}
