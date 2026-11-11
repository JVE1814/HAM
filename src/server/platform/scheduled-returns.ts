import { GlideRecord } from '@servicenow/glide'
import { addDays } from '../domain/calendar.ts'
import { collectionMethod, TEMPORARY_RETURN_STAGES } from '../domain/returns.ts'
import { type InstallMode, ORDER_STAGE, type OrderType, RETURN_TRIGGER } from '../domain/vocabulary.ts'
import { todayIso } from './clock.ts'
import { installedAssetIds, installedAssetIdsBySite } from './installed-assets.ts'
import { intProperty, PROPERTY } from './properties.ts'
import { exists, findById, str, warnRefused } from './records.ts'
import { raiseReturn } from './returns.ts'

/**
 * The Returns a date brings: an Agreement past its end and a temporary deployment about to end bring their equipment
 * back (P2.4). Each is raised once, which a mark on the Agreement (`end_return_raised`) and on the temporary Order
 * (`return_raised`) records; both marks are read and written here only.
 */

const END_RETURN_RAISED = 'end_return_raised'
const RETURN = 'x_daas_ham_return_order'

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
        const agreementId = agreement.getUniqueValue()
        const recover = `Agreement ${str(agreement, 'number')} ended ${str(agreement, 'ends')}: recover all equipment`
        // One Return per Site, each a field de-install with its own change and work order there. Units still shipped
        // there go too (domain/returns `SITE_RECOVERY_STAGES`): once all are raised, the job leaves this Agreement.
        const bySite = installedAssetIdsBySite({ agreementId, returning: 'agreement_end' })
        // The Returns this end raised: after the end date, so not those of an end before a renewal.
        const raisedForEnd = `trigger=${RETURN_TRIGGER.agreement_end}^agreement=${agreementId}^sys_created_on>=${str(agreement, 'ends')} 00:00:00`
        let refused = false
        for (const [siteId, assetIds] of bySite) {
            // Raised once per Site: a run sent round again (another Site's Return or the mark below refused) finds the
            // units that Return could not take (logged then) still there, and would raise an empty Return each day.
            if (exists(RETURN, `${raisedForEnd}^site=${siteId}`)) continue
            const site = findById('cmn_location', siteId)
            const raised = raiseReturn({
                trigger: 'agreement_end',
                customerId: str(agreement, 'customer'),
                siteId,
                agreementId,
                method: 'fsm_deinstall',
                assetIds,
                description: site ? `${recover} from ${str(site, 'name')}` : recover,
            })
            if (!raised) refused = true
        }
        // A refused Return is raised on the next run. Units put on a Return now are pending return, so not found again.
        if (refused) continue
        agreement.setValue(END_RETURN_RAISED, true)
        // Refused, the next run finds the Agreement again, raises no Return twice (above) and saves the mark again.
        if (!agreement.update()) warnRefused(agreement, `Agreement ${str(agreement, 'number')} not marked as its end Returns raised`)
    }
}

/** Temporary deployments ending within the lead time bring their equipment back, once. */
function returnTemporaryDeployments(today: string): void {
    const leadDays = intProperty(PROPERTY.temporaryReturnLeadDays)
    const horizon = addDays(today, leadDays)
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
        const orderId = order.getUniqueValue()
        const assetIds = installedAssetIds({ orderId, returning: 'temporary_end' })
        // The Return is raised once, so an Order still being installed waits until every unit is installed. Once its
        // end date has passed, the units still shipped come back too.
        const installing = str(order, 'stage') === ORDER_STAGE.installing && str(order, 'end_date') >= today
        if (installing && (assetIds.length === 0 || installedAssetIds({ orderId }).length < assetIds.length)) continue
        // Raised once: a run whose mark below was refused left the units that Return could not take (logged then).
        const raisedBefore = () => exists(RETURN, `trigger=${RETURN_TRIGGER.temporary_end}^source_order=${orderId}`)
        if (assetIds.length > 0 && !raisedBefore()) {
            const raised = raiseReturn({
                trigger: 'temporary_end',
                customerId: str(order, 'customer'),
                siteId: str(order, 'site'),
                agreementId: str(order, 'agreement'),
                method: collectionMethod(str(order, 'install_mode') as InstallMode | ''),
                assetIds,
                sourceOrderId: orderId,
                description: `Temporary deployment ${str(order, 'number')} ends ${str(order, 'end_date')}`,
            })
            // Refused: raised on the next run.
            if (!raised) continue
        }
        order.setValue('return_raised', true)
        // Refused, the next run finds the Order again, raises no second Return (above) and saves the mark again.
        if (!order.update()) warnRefused(order, `Temporary Order ${str(order, 'number')} not marked as its Return raised`)
    }
}
