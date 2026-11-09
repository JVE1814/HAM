import { GlideRecord, gs } from '@servicenow/glide'
import { refreshWaves, replacementModel, type RefreshCandidate, type RefreshWave } from '../domain/refresh.ts'
import type { LifecycleDates } from '../domain/model-lifecycle.ts'
import { toIsoDate } from '../domain/calendar.ts'
import { fleetStagesQuery } from '../domain/fleet.ts'
import { nowMs, todayIso } from '../platform/clock.ts'
import { modelLifecycle } from '../platform/lifecycle-dates.ts'
import { withLock, type HeldLock } from '../platform/locks.ts'
import { intProperty, PROPERTY } from '../platform/properties.ts'
import { pluck, refusal, str } from '../platform/records.ts'
import { submitOrder } from './orders.ts'

/** The job lock (ADR 0013) a refresh run holds from its read of the Assets due to its last Order. */
const REFRESH_LOCK = 'refresh_orders'

/**
 * Daily: refresh Orders for in-service Assets due within the horizon (P2.2, D48: fully automatic). Two runs at once
 * (the scheduled job and an *Execute now*) would both read an Asset as on no open replacing line and raise it twice, so
 * a run holds a job lock; one that finds it held raises nothing and logs so. Taking the lock throws only when an insert
 * is refused with no lock row (platform/locks): that error escapes.
 */
export function raiseRefreshOrders(): void {
    if (withLock(REFRESH_LOCK, raiseHolding)) return
    gs.info(`[x_daas_ham] Refresh Orders not raised: another run holds the ${REFRESH_LOCK} lock and raises them`)
}

/**
 * Raise a wave at a time holding `lock`. A run that outlasts it (ADR 0013) stops after the wave it lost it in: the run
 * that took it over read what is on order afresh and raises the rest, but may have read that wave's Assets before
 * their lines were saved.
 */
function raiseHolding(lock: HeldLock): void {
    for (const wave of refreshWaves(dueCandidates())) {
        const number = raiseWave(wave)
        if (lock.held()) continue
        const check = number ? `; check ${number}'s Assets are on no other open Order` : ''
        gs.error(`[x_daas_ham] Refresh run stopped, its lock lost: the run that took it over raises the rest${check}`)
        return
    }
}

/**
 * In-service fleet assets (ADR 0016) of an Agreement due within the horizon and on no open replacing line, earliest
 * due first. The Provider IT's equipment in use is in service by its install status too, and is left out.
 */
function dueCandidates(): RefreshCandidate[] {
    const horizon = toIsoDate(nowMs() + intProperty(PROPERTY.refreshHorizonDays, 90) * 86_400_000)
    const onOrder = new Set(
        pluck('x_daas_ham_order_line', 'replaces_assetISNOTEMPTY^order.stageNOT INcomplete,cancelled,rejected', 'replaces_asset'),
    )
    const candidates: RefreshCandidate[] = []
    const asset = new GlideRecord('alm_hardware')
    asset.addEncodedQuery(fleetStagesQuery(['in_service'], `x_daas_ham_refresh_due<=${horizon}^x_daas_ham_agreementISNOTEMPTY`))
    asset.orderBy('x_daas_ham_refresh_due')
    asset.setLimit(2000)
    asset.query()
    while (asset.next()) {
        if (onOrder.has(asset.getUniqueValue())) continue
        candidates.push({
            assetId: asset.getUniqueValue(),
            agreementId: str(asset, 'x_daas_ham_agreement'),
            customerId: str(asset, 'company'),
            siteId: str(asset, 'x_daas_ham_site'),
            modelId: str(asset, 'model'),
            deviceClass: str(asset, 'model.x_daas_ham_device_class'),
        })
    }
    return candidates
}

function catalogModels(customerId: string): Array<{ modelId: string; deviceClass: string }> {
    const entry = new GlideRecord('x_daas_ham_catalog_entry')
    entry.addQuery('customer', customerId)
    entry.addQuery('entry_type', 'model')
    entry.addQuery('active', true)
    entry.query()
    const models: Array<{ modelId: string; deviceClass: string }> = []
    while (entry.next()) models.push({ modelId: str(entry, 'model'), deviceClass: str(entry, 'model.x_daas_ham_device_class') })
    return models
}

/** Raise one wave's Order and lines and submit it: the Order's number, or '' when none was raised with a line. */
function raiseWave({ customerId, siteId, agreementId, assets }: RefreshWave): string {
    const catalog = catalogModels(customerId)
    const lifecycle = new Map<string, LifecycleDates>()
    for (const modelId of new Set([...catalog.map((c) => c.modelId), ...assets.map((a) => a.modelId)])) lifecycle.set(modelId, modelLifecycle(modelId))

    const order = new GlideRecord('x_daas_ham_order')
    order.initialize()
    order.setValue('order_type', 'refresh')
    order.setValue('customer', customerId)
    order.setValue('site', siteId)
    order.setValue('agreement', agreementId)
    order.setValue('install_mode', 'fsm_engineer')
    order.setValue('short_description', `Refresh of ${assets.length} asset(s) due by ${todayIso()}`)
    // Refused, or a line refused: those Assets are on no open line, so the next run raises them again.
    if (!order.insert()) {
        gs.warn(`[x_daas_ham] No refresh Order for site ${siteId}: ${refusal(order)}`)
        return ''
    }
    const unmatched: string[] = []
    let saved = 0
    for (const candidate of assets) {
        const modelId = replacementModel(candidate, catalog, lifecycle, todayIso())
        const line = new GlideRecord('x_daas_ham_order_line')
        line.initialize()
        line.setValue('order', order.getUniqueValue())
        line.setValue('model', modelId ?? candidate.modelId)
        line.setValue('quantity', 1)
        line.setValue('replaces_asset', candidate.assetId)
        if (!line.insert()) {
            gs.warn(`[x_daas_ham] Asset ${candidate.assetId} left off ${str(order, 'number')}: ${refusal(line)}`)
            continue
        }
        saved++
        if (!modelId) unmatched.push(candidate.assetId)
    }
    if (saved === 0) {
        removeEmpty(order, siteId)
        return ''
    }
    if (unmatched.length > 0) {
        // Left in draft for the account manager to adjust; a note the platform refuses is logged, to say why it waits.
        const note = `${unmatched.length} asset(s) have no sellable catalogued successor; their lines reuse the current model. Review before submitting.`
        order.setValue('work_notes', note)
        if (!order.update()) gs.warn(`[x_daas_ham] Refresh Order ${str(order, 'number')} left in draft, its note not saved (${note}): ${refusal(order)}`)
        return str(order, 'number')
    }
    submitOrder(order)
    return str(order, 'number')
}

/**
 * Remove a refresh Order none of whose lines was saved: it replaces nothing, Submit would leave it a draft, and the
 * next run raises its Assets on a new one, so each run would add another empty draft for as long as lines are refused.
 */
function removeEmpty(order: GlideRecord, siteId: string): void {
    const empty = `Refresh Order ${str(order, 'number')} for site ${siteId}`
    if (order.deleteRecord()) return void gs.warn(`[x_daas_ham] ${empty} removed: none of its lines was saved`)
    gs.warn(`[x_daas_ham] ${empty} has no lines and was not removed (${refusal(order, 'the delete was refused')}): cancel it`)
}
