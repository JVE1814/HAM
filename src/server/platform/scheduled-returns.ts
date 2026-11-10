import { GlideRecord } from '@servicenow/glide'
import { toIsoDate } from '../domain/calendar.ts'
import { collectionMethod, TEMPORARY_RETURN_STAGES } from '../domain/returns.ts'
import { type InstallMode, ORDER_STAGE, type OrderType } from '../domain/vocabulary.ts'
import { nowMs, todayIso } from './clock.ts'
import { installedAssetIds, installedAssetIdsBySite } from './installed-assets.ts'
import { intProperty, PROPERTY } from './properties.ts'
import { findById, str } from './records.ts'
import { raiseReturn } from './returns.ts'

/**
 * The Returns a date brings: an Agreement past its end and a temporary deployment about to end bring their equipment
 * back (P2.4). Each is raised once, which a mark on the Agreement (`end_return_raised`) and on the temporary Order
 * (`return_raised`) records; both marks are read and written here only.
 */

const END_RETURN_RAISED = 'end_return_raised'

/** Raise the Returns due today (the daily job): see `recoverEndedAgreements` and `returnTemporaryDeployments`. */
export function raiseDueReturns(): void {
    const today = todayIso()
    recoverEndedAgreements(today)
    returnTemporaryDeployments(today)
}

/**
 * An Agreement's end date moved to a day it has not ended by: its equipment is recovered again once that day has
 * passed (the caller saves the Agreement).
 */
export function recoverAgainAtEnd(agreement: GlideRecord): void {
    agreement.setValue(END_RETURN_RAISED, false)
}

/** Agreements past their end date bring all their equipment back, once. */
function recoverEndedAgreements(today: string): void {
    const agreement = new GlideRecord('x_daas_ham_agreement')
    agreement.addQuery('ends', '<', today)
    agreement.addQuery(END_RETURN_RAISED, false)
    agreement.addNotNullQuery('ends')
    agreement.setLimit(50)
    agreement.query()
    while (agreement.next()) {
        const recover = `Agreement ${str(agreement, 'number')} ended ${str(agreement, 'ends')}: recover all equipment`
        // One Return per Site, each a field de-install with its own change and work order there. Units still shipped
        // there go too (domain/returns `SITE_RECOVERY_STAGES`): once all are raised, the job leaves this Agreement.
        const bySite = installedAssetIdsBySite({ agreementId: agreement.getUniqueValue(), wholeSite: true })
        let refused = false
        for (const [siteId, assetIds] of bySite) {
            const site = findById('cmn_location', siteId)
            const raised = raiseReturn({
                trigger: 'agreement_end',
                customerId: str(agreement, 'customer'),
                siteId,
                agreementId: agreement.getUniqueValue(),
                method: 'fsm_deinstall',
                assetIds,
                description: site ? `${recover} from ${str(site, 'name')}` : recover,
            })
            if (!raised) refused = true
        }
        // A refused Return is raised on the next run. Units put on a Return now are pending return, so not found again.
        if (refused) continue
        agreement.setValue(END_RETURN_RAISED, true)
        // A refused mark is not logged: its units are pending return now, so the next run raises nothing and marks it.
        agreement.update()
    }
}

/** Temporary deployments ending within the lead time bring their equipment back, once. */
function returnTemporaryDeployments(today: string): void {
    const leadDays = intProperty(PROPERTY.temporaryReturnLeadDays)
    const horizon = toIsoDate(nowMs() + leadDays * 86_400_000)
    const order = new GlideRecord('x_daas_ham_order')
    const temporary: OrderType = 'temporary'
    order.addQuery('order_type', temporary)
    order.addQuery('return_raised', false)
    order.addNotNullQuery('end_date')
    order.addQuery('end_date', '<=', horizon)
    order.addQuery('stage', 'IN', TEMPORARY_RETURN_STAGES.join(','))
    order.orderBy('end_date')
    order.setLimit(50)
    order.query()
    while (order.next()) {
        const assetIds = installedAssetIds({ orderId: order.getUniqueValue() })
        // Still being installed and not yet ended: wait for the equipment to arrive before raising.
        if (assetIds.length === 0 && str(order, 'stage') === ORDER_STAGE.installing && str(order, 'end_date') >= today) continue
        if (assetIds.length > 0) {
            const raised = raiseReturn({
                trigger: 'temporary_end',
                customerId: str(order, 'customer'),
                siteId: str(order, 'site'),
                agreementId: str(order, 'agreement'),
                method: collectionMethod(str(order, 'install_mode') as InstallMode | ''),
                assetIds,
                sourceOrderId: order.getUniqueValue(),
                description: `Temporary deployment ${str(order, 'number')} ends ${str(order, 'end_date')}`,
            })
            // Refused: raised on the next run.
            if (!raised) continue
        }
        order.setValue('return_raised', true)
        // A refused mark is not logged: its units are pending return now, so a later run raises nothing and marks it.
        order.update()
    }
}
