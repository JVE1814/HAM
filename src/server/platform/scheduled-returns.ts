import { GlideRecord } from '@servicenow/glide'
import { addDays } from '../domain/calendar.ts'
import { JOB } from '../domain/chunked-job.ts'
import { messageOf } from '../domain/errors.ts'
import { PROPERTY } from '../domain/properties.ts'
import { collectionMethod, stagesTakenBack, TEMPORARY_RETURN_STAGES } from '../domain/returns.ts'
import { type InstallMode, ORDER_STAGE, type OrderType, RETURN_TRIGGER } from '../domain/vocabulary.ts'
import { todayIso } from './clock.ts'
import { installedAssetIds, installedAssetIdsBySite } from './installed-assets.ts'
import { openJobCursor, type JobCursor } from './job-cursor.ts'
import { log } from './log.ts'
import { intProperty } from './properties.ts'
import { exists, findById, str, warnRefused } from './records.ts'
import { raiseReturn, RETURN } from './returns.ts'

/**
 * Each is raised once, which a mark on the Agreement (`end_return_raised`) and on the temporary Order (`return_raised`)
 * records; both marks are read and written here only.
 */

const END_RETURN_RAISED = 'end_return_raised'

/** Ended Agreements, and ending temporary Orders, a run reads at most. */
const PAGE = 50

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

/**
 * Visit the next PAGE records of `table` that `where` selects, in sys_id order after the last one the run before read
 * (the job cursor `job`, which holds only that position), starting over after the last. `visit` says whether the
 * record is done with (marked, so the next query leaves it out) or left for a later run. A record left (a Return or a
 * mark refused, an Order still being installed) stays in the query: read first by every run, PAGE of them would keep
 * every record after them from ever being read.
 */
function visitNextPage(job: string, table: string, where: (record: GlideRecord) => void, visit: (record: GlideRecord) => boolean): void {
    const cursor = pageCursor(job)
    const after = cursor?.cursor ?? ''
    let page = readPage(table, where, after)
    if (after && !page.hasNext()) page = readPage(table, where, '')
    let read = 0
    let left = 0
    let last = ''
    while (page.next()) {
        read++
        last = page.getUniqueValue()
        if (!visit(page)) left++
    }
    if (cursor) savePageCursor(job, cursor, read === PAGE ? last : '')
    if (left === PAGE) log.warn(`${job}: each of the ${PAGE} records read was left for a later run; the next run reads on after them`)
}

function readPage(table: string, where: (record: GlideRecord) => void, after: string): GlideRecord {
    const record = new GlideRecord(table)
    where(record)
    if (after) record.addQuery('sys_id', '>', after)
    record.orderBy('sys_id')
    record.setLimit(PAGE)
    record.query()
    return record
}

function pageCursor(job: string): JobCursor | null {
    try {
        return openJobCursor(job)
    } catch (error) {
        log.warn(`Job cursor ${job} not created, so each run reads the same records first: ${messageOf(error)}`)
        return null
    }
}

function savePageCursor(job: string, cursor: JobCursor, next: string): void {
    if (cursor.cursor === next) return
    const refused = cursor.save({ cursor: next })
    if (refused) log.warn(`Job cursor ${job} not saved, so the next run reads the same records first: ${refused}`)
}

function recoverEndedAgreements(today: string): void {
    visitNextPage(
        JOB.endedAgreementReturns,
        'x_daas_ham_agreement',
        (agreement) => {
            agreement.addQuery('ends', '<', today)
            agreement.addQuery(END_RETURN_RAISED, false)
            agreement.addNotNullQuery('ends')
        },
        recoverEquipment,
    )
}

/** Raise the Returns of an ended Agreement and mark it. False when it is left for a later run: a Return or the mark was refused. */
function recoverEquipment(agreement: GlideRecord): boolean {
    const agreementId = agreement.getUniqueValue()
    const recover = `Agreement ${str(agreement, 'number')} ended ${str(agreement, 'ends')}: recover all equipment`
    // One Return per Site, each a field de-install with its own change and work order there. Units still shipped
    // there go too (domain/returns `stagesTakenBack`): once all are raised, the job leaves this Agreement.
    const bySite = installedAssetIdsBySite({ agreementId, stages: stagesTakenBack('agreement_end') })
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
    // A refused Return is raised on a later run. Units put on a Return now are pending return, so not found again.
    if (refused) return false
    agreement.setValue(END_RETURN_RAISED, true)
    if (agreement.update()) return true
    // Refused, a later run finds the Agreement again, raises no Return twice (above) and saves the mark again.
    warnRefused(agreement, `Agreement ${str(agreement, 'number')} not marked as its end Returns raised`)
    return false
}

function returnTemporaryDeployments(today: string): void {
    const horizon = addDays(today, intProperty(PROPERTY.temporaryReturnLeadDays))
    const temporary: OrderType = 'temporary'
    visitNextPage(
        JOB.temporaryOrderReturns,
        'x_daas_ham_order',
        (order) => {
            order.addQuery('order_type', temporary)
            order.addQuery('return_raised', false)
            order.addNotNullQuery('end_date')
            order.addQuery('end_date', '<=', horizon)
            order.addQuery('stage', 'IN', TEMPORARY_RETURN_STAGES.join(','))
        },
        (order) => returnDeployment(order, today),
    )
}

/**
 * Raise the Return of a temporary Order that ends and mark it. False when it is left for a later run: it is still
 * being installed, or its Return or the mark was refused.
 */
function returnDeployment(order: GlideRecord, today: string): boolean {
    const orderId = order.getUniqueValue()
    const assetIds = installedAssetIds({ orderId, stages: stagesTakenBack('temporary_end') })
    // The Return is raised once, so an Order still being installed waits until every unit is installed. Once its
    // end date has passed, the units still shipped come back too.
    const installing = str(order, 'stage') === ORDER_STAGE.installing && str(order, 'end_date') >= today
    if (installing && (assetIds.length === 0 || installedAssetIds({ orderId }).length < assetIds.length)) return false
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
        if (!raised) return false
    }
    order.setValue('return_raised', true)
    if (order.update()) return true
    // Refused, a later run finds the Order again, raises no second Return (above) and saves the mark again.
    warnRefused(order, `Temporary Order ${str(order, 'number')} not marked as its Return raised`)
    return false
}
