import { GlideRecord, gs } from '@servicenow/glide'
import { addDays } from '../domain/calendar.ts'
import { fleetStagesQuery } from '../domain/fleet.ts'
import type { HeldLock } from '../domain/job-lock.ts'
import type { LifecycleDates } from '../domain/model-lifecycle.ts'
import { refreshWaves, replacementModel, type RefreshCandidate, type RefreshWave } from '../domain/refresh.ts'
import { catalogModels } from './agreements.ts'
import { todayIso } from './clock.ts'
import { readModelLifecycle } from './model-lifecycle.ts'
import { createOrder, submitOrder, type NewLine } from './orders.ts'
import { intProperty, PROPERTY } from './properties.ts'
import { pluck, str } from './records.ts'

/** Refresh Orders for in-service Assets due within the horizon (P2.2, D48: fully automatic). */

/**
 * Raise the refresh Orders due, a wave at a time, holding the run's `lock`. A run that outlasts it (ADR 0013) stops
 * after the wave it lost it in: the run that took it over read what is on order afresh and raises the rest, but may
 * have read that wave's Assets before their lines were saved.
 */
export function raiseDueRefreshOrders(lock: HeldLock): void {
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
    const horizon = addDays(todayIso(), intProperty(PROPERTY.refreshHorizonDays, 90))
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

/**
 * Raise one wave's Order and lines and submit it: the Order's number, or '' when none was raised with a line. An
 * Order refused, or a line refused, leaves those Assets on no open line, so the next run raises them again. An Order
 * none of whose lines was saved is removed again (platform/orders `createOrder`): it replaces nothing, Submit would
 * leave it a draft, and each run would add another empty draft for as long as lines are refused.
 */
function raiseWave({ customerId, siteId, agreementId, assets }: RefreshWave): string {
    const catalog = catalogModels(customerId)
    const lifecycle = new Map<string, LifecycleDates>()
    for (const modelId of new Set([...catalog.map((c) => c.modelId), ...assets.map((a) => a.modelId)])) lifecycle.set(modelId, readModelLifecycle(modelId))

    const today = todayIso()
    // A unit with no sellable catalogued successor is replaced by its own Model, for the account manager to review.
    const unmatched = new Set<NewLine>()
    const lines = assets.map((candidate) => {
        const successor = replacementModel(candidate, catalog, lifecycle, today)
        const line: NewLine = { modelId: successor ?? candidate.modelId, quantity: 1, replacesAssetId: candidate.assetId }
        if (!successor) unmatched.add(line)
        return line
    })
    const raised = createOrder(
        {
            orderType: 'refresh',
            customerId,
            siteId,
            agreementId,
            installMode: 'fsm_engineer',
            shortDescription: `Refresh of ${assets.length} asset(s) due by ${today}`,
        },
        lines,
    )
    if (!raised.created && raised.step === 'order') {
        gs.warn(`[x_daas_ham] No refresh Order for site ${siteId}: ${raised.reason}`)
        return ''
    }
    const number = raised.created ? str(raised.order, 'number') : raised.number
    for (const { line, reason } of raised.refused) {
        gs.warn(`[x_daas_ham] Asset ${line.replacesAssetId} left off ${number}: ${reason}`)
        unmatched.delete(line)
    }
    if (!raised.created) {
        const empty = `Refresh Order ${number} for site ${siteId}`
        if (!raised.kept) gs.warn(`[x_daas_ham] ${empty} removed: none of its lines was saved`)
        else gs.warn(`[x_daas_ham] ${empty} has no lines and was not removed (${raised.kept}): cancel it`)
        return ''
    }
    const order = raised.order
    if (unmatched.size > 0) {
        order.setValue('work_notes', `${unmatched.size} asset(s) have no sellable catalogued successor; their lines reuse the current model. Review before submitting.`)
        order.update()
        return number // left in draft for the account manager to adjust
    }
    const submission = submitOrder(order)
    // Nobody is there to be told: the Order stays a draft for the account manager, with why in the log.
    if (!submission.submitted) gs.warn(`[x_daas_ham] Refresh Order ${number} left a draft: ${submission.message}`)
    return number
}
