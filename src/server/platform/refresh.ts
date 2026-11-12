import { GlideRecord } from '@servicenow/glide'
import { addDays } from '../domain/calendar.ts'
import { fleetStagesQuery } from '../domain/fleet.ts'
import type { HeldLock } from '../domain/job-lock.ts'
import type { LifecycleDates } from '../domain/model-lifecycle.ts'
import {
    dueAfter,
    firstCandidatesDue,
    REFRESH_DUE_FIELD,
    refreshWaves,
    replacementModel,
    type DueKey,
    type DueRow,
    type RefreshCandidate,
    type RefreshWave,
} from '../domain/refresh.ts'
import { LOCK } from '../domain/lock-names.ts'
import { catalogModels } from './agreements.ts'
import { nowMs, todayIso } from './clock.ts'
import { readModelLifecycle } from './model-lifecycle.ts'
import type { NewLine } from './order-lines.ts'
import { createOrder, submitOrder } from './orders.ts'
import { withLock } from './locks.ts'
import { intProperty } from './properties.ts'
import { PROPERTY } from '../domain/properties.ts'
import { pluck, str, warnRefused } from './records.ts'
import { OPEN_ORDERS_QUERY } from '../domain/fulfilment.ts'
import { log } from './log.ts'

/** Refresh Orders for in-service Assets due within the horizon (P2.2, Q48: fully automatic). */

const CANDIDATES_PER_RUN = 2000

/**
 * Daily job: the refresh Orders due. Two runs at once (the scheduled job and an *Execute now*) would both read an Asset
 * as on no open replacing line and raise it twice, so a run holds a job lock (ADR 0013) from its read of the Assets due
 * to its last Order; one that finds it held raises nothing and logs so. Taking the lock throws only when an insert is
 * refused with no lock row (platform/locks): that error escapes.
 */
export function raiseRefreshOrders(): void {
    const lockName = LOCK.refreshOrders()
    if (withLock(lockName, raiseDueHolding).ran) return
    log.info(`Refresh Orders not raised: another run holds the ${lockName} lock and raises them`)
}

/**
 * Raise the refresh Orders due, a wave at a time, holding the run's `lock`. A run that outlasts it (ADR 0013) stops
 * after the wave it lost it in: the run that took it over read what is on order afresh and raises the rest, but may
 * have read that wave's Assets before their lines were saved.
 */
function raiseDueHolding(lock: HeldLock): void {
    for (const wave of refreshWaves(dueCandidates())) {
        const number = raiseWave(wave)
        if (lock.held()) continue
        const check = number ? `; check ${number}'s Assets are on no other open Order` : ''
        log.error(`Refresh run stopped, its lock lost: the run that took it over raises the rest${check}`)
        return
    }
}

/**
 * In-service fleet assets (ADR 0016) of an Agreement due within the horizon and on no open replacing line, earliest
 * due first. The Provider IT's equipment in use is in service by its install status too, and is left out. Read a page
 * at a time past those on order (domain/refresh `firstCandidatesDue`), within the job time budget.
 */
function dueCandidates(): RefreshCandidate[] {
    const horizon = addDays(todayIso(), intProperty(PROPERTY.refreshHorizonDays))
    const onOrder = new Set(
        pluck('x_daas_ham_order_line', `replaces_assetISNOTEMPTY^order.${OPEN_ORDERS_QUERY}`, 'replaces_asset'),
    )
    const due = fleetStagesQuery(['in_service'], `${REFRESH_DUE_FIELD}<=${horizon}^x_daas_ham_agreementISNOTEMPTY`)
    const started = nowMs()
    const budgetMs = intProperty(PROPERTY.jobBudgetSeconds) * 1000
    const readPage = (after: DueKey | null, size: number): DueRow[] => {
        const asset = new GlideRecord('alm_hardware')
        asset.addEncodedQuery(dueAfter(due, after))
        asset.orderBy(REFRESH_DUE_FIELD)
        asset.orderBy('sys_id')
        asset.setLimit(size)
        asset.query()
        const rows: DueRow[] = []
        while (asset.next()) {
            const id = asset.getUniqueValue()
            const key = { due: str(asset, REFRESH_DUE_FIELD), id }
            rows.push({ key, candidate: onOrder.has(id) ? null : candidateOf(asset) })
        }
        return rows
    }
    return firstCandidatesDue(readPage, CANDIDATES_PER_RUN, () => nowMs() - started >= budgetMs)
}

function candidateOf(asset: GlideRecord): RefreshCandidate {
    return {
        assetId: asset.getUniqueValue(),
        agreementId: str(asset, 'x_daas_ham_agreement'),
        customerId: str(asset, 'company'),
        siteId: str(asset, 'x_daas_ham_site'),
        modelId: str(asset, 'model'),
        deviceClass: str(asset, 'model.x_daas_ham_device_class'),
    }
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
        log.warn(`No refresh Order for site ${siteId}: ${raised.reason}`)
        return ''
    }
    const number = raised.created ? str(raised.order, 'number') : raised.number
    for (const { line, reason } of raised.refused) {
        log.warn(`Asset ${line.replacesAssetId} left off ${number}: ${reason}`)
        unmatched.delete(line)
    }
    if (!raised.created) {
        const empty = `Refresh Order ${number} for site ${siteId}`
        if (!raised.kept) log.warn(`${empty} removed: none of its lines was saved`)
        else log.warn(`${empty} has no lines and was not removed (${raised.kept}): cancel it`)
        return ''
    }
    const order = raised.order
    if (unmatched.size > 0) {
        order.setValue('work_notes', `${unmatched.size} asset(s) have no sellable catalogued successor; their lines reuse the current model. Review before submitting.`)
        // Without the note nothing tells the account manager why the Order is a draft.
        if (!order.update()) warnRefused(order, `Refresh Order ${number}: note on its ${unmatched.size} unmatched asset(s) not saved`)
        return number
    }
    const submission = submitOrder(order)
    // Nobody is there to be told: the Order stays a draft for the account manager, with why in the log.
    if (!submission.submitted) log.warn(`Refresh Order ${number} left a draft: ${submission.message}`)
    return number
}
