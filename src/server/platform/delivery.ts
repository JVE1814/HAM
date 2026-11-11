import { GlideRecord } from '@servicenow/glide'
import { installsOrder, planShipment, replacementInstalled, type OnSiteWork } from '../domain/delivery.ts'
import {
    awaitsInstall,
    installRefusal,
    type InstallConfirmer,
    type InstallRefusal,
    type InstallState,
} from '../domain/install-confirmation.ts'
import type { HeldLock } from '../domain/job-lock.ts'
import { isDeployed, stagesQuery } from '../domain/lifecycle.ts'
import { LOCK } from '../domain/lock-names.ts'
import { collectionMethod } from '../domain/returns.ts'
import type { InstallMode, OrderStage, OrderType } from '../domain/vocabulary.ts'
import { moveAndSave, moveAsset, readStage } from './assets.ts'
import { beyondVisibility } from './beyond-visibility.ts'
import { nowGlide } from './clock.ts'
import { openFieldWork, type WorkContext } from './field-work.ts'
import { lineAssetStages, recomputeOrder } from './fulfilment.ts'
import { withLock } from './locks.ts'
import { choice, findById, num, refusal, str, type ForeignRecord } from './records.ts'
import { raiseReturn } from './returns.ts'
import { labelOrder, orderLabelBought, shippingEnabled } from './shipping.ts'

/**
 * Shipping Orders to their Site, the on-site work, and install completion (P1.7). None of it tells the user anything:
 * each gives what came of it, for the trigger that asked (a form button, a closed work order, the customer page) to
 * report.
 */

function orderAssets(orderId: string): GlideRecord {
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('x_daas_ham_order_line.order', orderId)
    asset.query()
    return asset
}

/**
 * What the install confirmation rules read of `order` (domain/install-confirmation). Its shipped units are counted at
 * most once, and as `completeInstall` finds them for the same user, so a confirmation offered has units to move.
 */
export function installState(order: GlideRecord): InstallState {
    const orderId = order.getUniqueValue()
    let shipped: number | undefined
    return {
        stage: str(order, 'stage') as OrderStage,
        installMode: str(order, 'install_mode') as InstallMode,
        shippedUnits: () => {
            if (shipped === undefined) shipped = countShipped(orderId)
            return shipped
        },
    }
}

function countShipped(orderId: string): number {
    const asset = orderAssets(orderId)
    let count = 0
    while (asset.next()) if (awaitsInstall(readStage(asset))) count++
    return count
}

/** What came of a Ship: what went wrong, in the order it did, and what was sent (null when nothing was). */
export interface ShipOutcome {
    problems: string[]
    shipped: { units: number; siteName: string } | null
}

function notShipped(problem: string): ShipOutcome {
    return { problems: [problem], shipped: null }
}

/**
 * Ship an Order: send every staged Asset the lifecycle lets ship to the Site (buying the label for those when the
 * aggregator is on, platform/shipping, rather than ask for a tracking number entered by hand) and open the on-site work. Hot spares already at the Site are handed over as shipped, without a
 * package. Which Assets may ship is checked before a label is bought.
 *
 * Two users pressing Ship while the first label purchase is in flight would both find the Order unshipped, and both
 * buy a label and open a change and work order. So Ship runs under a lock on the Order, from the Order read again
 * there; one that finds the lock held ships nothing and says another Ship is running. Taking the lock throws only
 * when an insert is refused with no lock row (platform/locks); that error escapes.
 */
export function shipOrder(orderId: string): ShipOutcome {
    const ship = withLock(LOCK.shipOrder(orderId), (lock) => {
        // A Ship that ran meanwhile has put its tracking number and work order on the Order, and shipped its units.
        const fresh = findById('x_daas_ham_order', orderId)
        return fresh ? shipHolding(lock, fresh) : notShipped('Order not found')
    })
    return ship.ran ? ship.value : notShipped('Another Ship of this Order is running: reload the Order to see what it shipped')
}

function shipHolding(lock: HeldLock, order: GlideRecord): ShipOutcome {
    const siteId = str(order, 'site')
    const found = shippable(order.getUniqueValue(), siteId)
    const trackingNumber = str(order, 'tracking_number')
    const plan = planShipment({
        orderType: str(order, 'order_type') as OrderType,
        installMode: str(order, 'install_mode') as InstallMode,
        hasTrackingNumber: !!trackingNumber,
        trackingNumberBought: !!trackingNumber && orderLabelBought(order.getUniqueValue(), trackingNumber),
        hasWorkOrder: !!str(order, 'work_order'),
        staged: found.staged.length,
        refused: found.refused,
        refusedReason: found.reason,
        hotSpares: found.hotSpares.length,
        shippingEnabled: shippingEnabled(),
    })
    const problems = [...plan.errors]
    if (!plan.ok) return { problems, shipped: null }
    if (plan.labelPackages !== null) {
        const label = labelOrder(order, plan.labelPackages, lock)
        if (!label.ok) return { problems: [...problems, `No shipping label: ${label.error}`], shipped: null }
        // The label is paid for and its Shipment saved, so the units still ship; only the Order lacks its tracking.
        if (label.orderRefusal) problems.push(`Tracking number ${label.trackingNumber} not saved on the Order: ${label.orderRefusal}`)
    }
    const hotSpares = new Set(found.hotSpares)
    const asset = new GlideRecord('alm_hardware')
    // Found past the visibility rules as shippable() found them; saved with every rule, so the line moves on.
    asset.addQuery('sys_id', 'IN', [...found.staged, ...found.hotSpares].join(','))
    beyondVisibility(asset, () => asset.query())
    let units = 0
    while (asset.next()) {
        // The label purchase takes time: an Asset moved on meanwhile is left alone.
        if (readStage(asset) !== (hotSpares.has(asset.getUniqueValue()) ? 'spare_pool' : 'staged')) continue
        placeAtSite(asset, siteId)
        // A hot spare is handed over where it is, as shipped: otherwise its line never gets past ready to ship.
        if (moveAndSave(asset, 'shipped', `ship ${str(order, 'number')}`)) units++
    }
    if (plan.onSiteWork) {
        const unopened = openOnSiteWork(order, plan.onSiteWork)
        if (unopened) problems.push(unopened)
    }
    recomputeOrder(order.getUniqueValue())
    return { problems, shipped: { units, siteName: str(order, 'site.name') } }
}

/**
 * The Order's staged Assets and hot spares that may ship to `siteId` (sys_ids), with how many are refused
 * and the first reason. Each is tried with the move Ship makes, on the Site Ship gives it, without saving.
 * They are read past the user's before-query rules (ADR 0005): an inventory tech sees only the Assets of
 * their stockrooms, and a hot spare sits in the customer-site stockroom.
 */
function shippable(orderId: string, siteId: string): { staged: string[]; hotSpares: string[]; refused: number; reason: string } {
    const asset = new GlideRecord('alm_hardware')
    asset.addEncodedQuery(stagesQuery(['staged', 'spare_pool'], `x_daas_ham_order_line.order=${orderId}`))
    beyondVisibility(asset, () => asset.query())
    const found = { staged: [] as string[], hotSpares: [] as string[], refused: 0, reason: '' }
    while (asset.next()) {
        const hotSpare = readStage(asset) === 'spare_pool'
        placeAtSite(asset, siteId)
        const verdict = moveAsset(asset, 'shipped')
        if (verdict.allowed) (hotSpare ? found.hotSpares : found.staged).push(asset.getUniqueValue())
        else {
            found.refused++
            found.reason ||= verdict.reason
        }
    }
    return found
}

function placeAtSite(asset: GlideRecord, siteId: string): void {
    asset.setValue('x_daas_ham_site', siteId)
    asset.setValue('location', siteId)
}

function openOnSiteWork(order: GlideRecord, work: OnSiteWork): string | null {
    const context: WorkContext = {
        customerId: str(order, 'customer'),
        siteId: str(order, 'site'),
        description: `${str(order, 'number')}: ${str(order, 'order_type')} at ${str(order, 'site.name')}`,
        sourceId: order.getUniqueValue(),
    }
    const opened = openFieldWork(context, work)
    if (!opened) return 'On-site work not opened (see the system log): open it by hand'
    order.setValue('change_request', opened.changeId)
    order.setValue('work_order', opened.workOrderId)
    // Unlinked, the next Ship opens the work again; the change and work order name the Order, to link them by hand.
    return order.update() ? null : `On-site work opened but not linked to the Order: ${refusal(order)}`
}

/** What came of a confirmation: how many units the platform refused to move, or why nothing was recorded. */
export type InstallConfirmation = { confirmed: true; refused: number } | { confirmed: false; why: InstallRefusal | 'unsaved' }

/**
 * Record `order` as installed for `confirmer`, when domain/install-confirmation `installRefusal` lets them. The units
 * take the Order's Site as `order` holds it, so `saveForm` first saves the values a user typed on its form (`unsaved`
 * when the platform refused that save, and said why).
 */
export function confirmInstall(order: GlideRecord, confirmer: InstallConfirmer, saveForm: () => boolean = () => true): InstallConfirmation {
    const why = installRefusal(confirmer, installState(order))
    if (why) return { confirmed: false, why }
    if (!saveForm()) return { confirmed: false, why: 'unsaved' }
    return { confirmed: true, refused: completeInstall(order) }
}

/**
 * Record an Order's shipped units as installed. How many units the platform refused to move (logged): they and their
 * line stay where they were, and so does the Asset their line replaces, so confirming again retries only them and then
 * retires it.
 *
 * Only shipped units move (domain/install-confirmation `awaitsInstall`): on an Order held back by a line filled again
 * after a unit was lost in transit, that line's new units, a hot spare allocated to it included, wait for Ship.
 */
function completeInstall(order: GlideRecord): number {
    const now = nowGlide()
    const asset = orderAssets(order.getUniqueValue())
    let refused = 0
    while (asset.next()) {
        if (!awaitsInstall(readStage(asset))) continue
        asset.setValue('x_daas_ham_install_completed', now)
        asset.setValue('x_daas_ham_site', str(order, 'site'))
        if (!moveAndSave(asset, 'pending_in_service', `install ${str(order, 'number')}`)) refused++
    }
    retireReplacedAssets(order)
    recomputeOrder(order.getUniqueValue())
    return refused
}

/**
 * A work order was closed complete: when it is the on-site work of the NaaS Order it was initiated from (domain/delivery
 * `installsOrder`; a de-install or audit job is not), that Order's install is complete.
 */
export function completeInstallOfWork(current: ForeignRecord): void {
    const order = findById('x_daas_ham_order', str(current, 'initiated_from'))
    if (order && installsOrder(str(current, 'x_daas_ham_purpose'))) completeInstall(order)
}

/**
 * The Assets an Order replaced (break-fix, refresh) come out of service and go back on a Return order, each once its
 * own line's replacement is installed: retired beside a replacement still shipped, the Site would lose the device.
 * The line's units are read past the user's before-query rules, as when its stage is derived (ADR 0005).
 */
function retireReplacedAssets(order: GlideRecord): void {
    const line = new GlideRecord('x_daas_ham_order_line')
    line.addQuery('order', order.getUniqueValue())
    line.addNotNullQuery('replaces_asset')
    line.query()
    const replaced: string[] = []
    while (line.next()) {
        const replacement = { quantity: num(line, 'quantity'), assetStages: lineAssetStages(line.getUniqueValue()) }
        if (!replacementInstalled(replacement)) continue
        const asset = findById('alm_hardware', str(line, 'replaces_asset'))
        const stage = asset ? readStage(asset) : null
        // Already pending return: an earlier completion (UI action, then work order close) raised it.
        if (asset && isDeployed(stage) && stage !== 'pending_return') replaced.push(asset.getUniqueValue())
    }
    returnReplacedAssets(order, replaced)
}

/**
 * The Assets an install replaced (refresh swap-back, defective unit) go back on a Return, which opens no de-install
 * work: the swap work order already collects the old unit (domain/returns `opensDeinstallWork`). When the platform
 * refuses it (platform/returns `raiseReturn` logs why) the units stay in service and billed, and completing the install
 * again raises it, as they are not yet pending return.
 */
function returnReplacedAssets(order: GlideRecord, assetIds: readonly string[]): void {
    if (assetIds.length === 0) return
    const refresh = choice<OrderType>(order, 'order_type') === 'refresh'
    raiseReturn({
        trigger: refresh ? 'refresh_swap_back' : 'defective_return',
        customerId: str(order, 'customer'),
        siteId: str(order, 'site'),
        agreementId: str(order, 'agreement'),
        method: collectionMethod(str(order, 'install_mode') as InstallMode),
        assetIds,
        sourceOrderId: order.getUniqueValue(),
        description: `${refresh ? 'Refresh swap-back' : 'Defective unit'} from ${str(order, 'number')}`,
    })
}
