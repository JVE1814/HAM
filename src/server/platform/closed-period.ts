import { GlideRecord } from '@servicenow/glide'
import { BILLING_PERIOD_STATUS } from '../domain/vocabulary.ts'
import { noneLeft, str, throwRefused } from './records.ts'

/**
 * The lock on a closed Billing period. Two before update/delete rules refuse any change to a closed period and to its
 * lines (`closedPeriodRefusal`, `closedLineRefusal`). The writes that must get past them are made here, without running
 * the rules: a write anywhere else that turns the rules off would unlock a closed bill unseen.
 */

const LINE = 'x_daas_ham_billing_line'

/** Why this save or delete of a period is refused: it is closed. Null for one that is not. */
export function closedPeriodRefusal(current: GlideRecord, previous: GlideRecord | null): string | null {
    return str(previous ?? current, 'status') === BILLING_PERIOD_STATUS.closed ? 'This billing period is closed and locked' : null
}

/**
 * Save a margin pass's failure count and last error on its Billing period (0 and '' clear them). The period is closed
 * and locked; these fields are about Margin, not the bill, so the save is made without the period's rules. Throws when
 * the platform refuses it: a period whose count is not saved would read as complete.
 */
export function recordMarginOutcome(period: GlideRecord, failed: number, error: string): void {
    period.setValue('margin_failed', failed)
    period.setValue('margin_error', error.slice(0, 255))
    period.setWorkflow(false)
    if (!period.update()) throwRefused(period, 'Margin status not saved')
}

/**
 * Why this save or delete of a Billing line is refused: a closed period's lines never change. The dot-walk on current
 * follows the period being saved, so an update moving the line to another period also checks the stored one: no line
 * leaves a closed period. Null for a line of no closed period.
 */
export function closedLineRefusal(current: GlideRecord, previous: GlideRecord): string | null {
    const statuses = [str(current, 'billing_period.status')]
    if (current.operation() === 'update' && str(previous, 'billing_period') !== str(current, 'billing_period')) {
        statuses.push(str(previous, 'billing_period.status'))
    }
    return statuses.includes(BILLING_PERIOD_STATUS.closed) ? 'This billing period is closed; its lines cannot change' : null
}

/**
 * Delete the lines of a period being regenerated, without the lines' rules: the period is generating, not closed, so
 * the lock has nothing to stop. False when a line is left.
 */
export function dropLinesForRegeneration(period: GlideRecord): boolean {
    const lines = `billing_period=${period.getUniqueValue()}`
    const line = new GlideRecord(LINE)
    line.addEncodedQuery(lines)
    line.setWorkflow(false)
    line.deleteMultiple()
    return noneLeft(LINE, lines)
}
