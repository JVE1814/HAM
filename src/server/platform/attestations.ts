import { GlideRecord, gs } from '@servicenow/glide'
import { ATTESTATION_STATE, attestationDue } from '../domain/audit.ts'
import { fleetStagesQuery } from '../domain/fleet.ts'
import { ATTESTATION_RESPONSE_CHOICES } from '../domain/vocabulary.ts'
import { ACTIVE_AGREEMENTS } from './agreements.ts'
import { customerAdminIds } from './approvals.ts'
import { glideToIsoDate, nowGlide, todayIso } from './clock.ts'
import { openException } from './exceptions.ts'
import { bool, exists, findById, num, refusal, str, warnRefused } from './records.ts'
import { installedAssetIds } from './installed-assets.ts'
import { IN_USE_STAGES } from '../domain/lifecycle.ts'

/**
 * Attestations: a Customer admin confirms the equipment installed at a Site (P2.7, D63). The daily job raises them,
 * the customer page answers and submits them. None of it tells the user anything: each gives what came of it.
 */

const ATTESTATION = 'x_daas_ham_attestation'
const ITEM = 'x_daas_ham_attestation_item'

/**
 * The attestations still open: those whose task is active, pending or open to answer. What keeps a second one from
 * being raised at a Site, and what the customer page lists.
 */
export const OPEN_ATTESTATIONS = 'active=true'

/**
 * Open an attestation for each Site with fleet assets of an attesting Agreement, once none is open there and the last
 * one was attested longer ago than the Agreement's interval (or never). One attestation covers every fleet asset
 * installed at the Site, so a Site that several Agreements serve follows the shortest of their intervals; the
 * attestation records the Agreement whose interval raised it.
 */
export function raiseDueAttestations(): void {
    const today = todayIso()
    const agreement = new GlideRecord('x_daas_ham_agreement')
    agreement.addEncodedQuery(ACTIVE_AGREEMENTS)
    agreement.addQuery('attestation_interval_months', '>', 0)
    agreement.query()
    while (agreement.next()) {
        const sites = new Set<string>()
        const asset = new GlideRecord('alm_hardware')
        asset.addEncodedQuery(fleetStagesQuery(IN_USE_STAGES, `x_daas_ham_agreement=${agreement.getUniqueValue()}`))
        asset.query()
        while (asset.next()) if (str(asset, 'x_daas_ham_site')) sites.add(str(asset, 'x_daas_ham_site'))
        for (const siteId of sites) {
            if (exists(ATTESTATION, `site=${siteId}^${OPEN_ATTESTATIONS}`)) continue
            const last = lastAttestedOn(siteId)
            if (!attestationDue({ lastAttestedOn: last, intervalMonths: num(agreement, 'attestation_interval_months'), today })) continue
            openAttestation(agreement, siteId)
        }
    }
}

function lastAttestedOn(siteId: string): string | undefined {
    const last = new GlideRecord(ATTESTATION)
    last.addQuery('site', siteId)
    last.addNotNullQuery('attested_at')
    last.orderByDesc('attested_at')
    last.setLimit(1)
    last.query()
    return last.next() ? glideToIsoDate(str(last, 'attested_at')) : undefined
}

function openAttestation(agreement: GlideRecord, siteId: string): void {
    const customerId = str(agreement, 'customer')
    const attestation = new GlideRecord(ATTESTATION)
    attestation.initialize()
    attestation.setValue('customer', customerId)
    attestation.setValue('site', siteId)
    attestation.setValue('agreement', agreement.getUniqueValue())
    attestation.setValue('assigned_to', customerAdminIds(customerId)[0] ?? '')
    attestation.setValue('short_description', 'Confirm the equipment installed at your site')
    attestation.setValue('state', ATTESTATION_STATE.pending)
    const attestationId = attestation.insert()
    if (!attestationId) return void warnRefused(attestation, `No attestation for site ${siteId}`)
    let why = listAttested(attestationId, installedAssetIds({ siteId }))
    if (!why) {
        attestation.setValue('state', ATTESTATION_STATE.open)
        if (attestation.update()) return
        why = `not opened: ${refusal(attestation)}`
    }
    const kept = attestation.deleteRecord() ? '' : `; ${str(attestation, 'number')} stays pending, cancel it`
    gs.warn(`[x_daas_ham] No attestation for site ${siteId}: ${why}${kept}`)
}

function listAttested(attestationId: string, assetIds: readonly string[]): string {
    for (const assetId of assetIds) {
        const item = new GlideRecord(ITEM)
        item.initialize()
        item.setValue('attestation', attestationId)
        item.setValue('asset', assetId)
        if (!item.insert()) return `asset ${assetId} not listed: ${refusal(item)}`
    }
    return ''
}

/**
 * The attestation the reader may see (their visibility rules apply) while it is not closed complete. Wider than
 * `OPEN_ATTESTATIONS`: it also finds one cancelled by hand, which `completeAttestation` then refuses to close (logged).
 */
export function findUnclosedAttestation(attestationId: string): GlideRecord | null {
    const attestation = findById(ATTESTATION, attestationId)
    return attestation && num(attestation, 'state') !== ATTESTATION_STATE.closed ? attestation : null
}

/** One answer as the customer page sends it: the attestation item and the response chosen for its Asset. */
export interface AttestationAnswer {
    id?: string
    response?: string
}

/**
 * Save the Customer's answers on the attestation's items; how many the platform refused (each logged). An answer that
 * names no item of this attestation, or a response the list does not offer, is skipped.
 */
export function saveAttestationAnswers(attestation: GlideRecord, answers: readonly AttestationAnswer[]): number {
    let refused = 0
    for (const answer of answers) {
        if (!Object.keys(ATTESTATION_RESPONSE_CHOICES).includes(String(answer.response))) continue
        const item = findById(ITEM, String(answer.id ?? ''))
        if (!item || str(item, 'attestation') !== attestation.getUniqueValue()) continue
        item.setValue('response', String(answer.response))
        if (item.update()) continue
        refused++
        warnRefused(item, `${str(attestation, 'number')}: answer for ${str(item, 'asset.serial_number')} not saved`)
    }
    return refused
}

export function hasUnansweredItems(attestation: GlideRecord): boolean {
    return exists(ITEM, `attestation=${attestation.getUniqueValue()}^responseISEMPTY`)
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
    const item = new GlideRecord(ITEM)
    item.addQuery('attestation', attestation.getUniqueValue())
    item.addQuery('response', 'missing')
    item.query()
    while (item.next()) {
        openException('attested_missing', { assetId: str(item, 'asset') }, { customerId: str(attestation, 'customer'), detail: `Reported not present in ${number}` })
    }
    attestation.setValue('attested_by', gs.getUserID())
    attestation.setValue('attested_at', nowGlide())
    attestation.setValue('state', ATTESTATION_STATE.closed)
    return attestation.update() ? '' : warnRefused(attestation, `Attestation ${number} not closed`)
}

function notClosed(number: string, reason: string): string {
    gs.warn(`[x_daas_ham] Attestation ${number} not closed: ${reason}`)
    return reason
}
