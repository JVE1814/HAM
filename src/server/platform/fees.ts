import { GlideRecord } from '@servicenow/glide'
import { chargedFeeQuery, type FeeIdentity } from '../domain/fees.ts'
import type { HeldLock } from '../domain/job-lock.ts'
import { LOCK } from '../domain/lock-names.ts'
import { FEE_STATUS, type FeeType } from '../domain/vocabulary.ts'
import { todayIso } from './clock.ts'
import { attemptLock, whyNotRun } from './locks.ts'
import { log } from './log.ts'
import { exists, findById, num, str, warnRefused } from './records.ts'

/**
 * Fee events (x_daas_ham_fee_event) as the returns process (P2.4) charges and waives them. A Billing period puts them on
 * itself, takes them off and marks them billed (platform/billing).
 */

const FEE = 'x_daas_ham_fee_event'

/** The Agreement field that holds what a Fee event of each type is charged. */
const AGREEMENT_FEE: Record<FeeType, string> = { lost: 'lost_asset_fee', damaged: 'damage_fee', late_return: 'late_return_fee' }

/**
 * Charge a Fee event of `type` for the Asset on the Return order, once (domain/fees `chargedFeeQuery`): a step
 * retried after a refused save (an evaluation chosen again, a line declared missing again) does not charge it twice.
 * Two runs may also charge it at the same time (two users saving one line's evaluation, overlapping overdue runs; two
 * scans of one unit already take turns under its receive lock, platform/receiving). A unique index on the fee's
 * identity would also refuse a fee charged after a waived one, so the check and the insert are made under a lock on the
 * fee, re-checking there (as platform/exceptions `openException`). A run that finds the lock held through every try
 * (LOCK.fee) leaves the fee to the holder, which is charging it unless it is billing one charged already. A fee that is
 * refused, that the holder has still not charged when this run gives up, or whose lock cannot be taken is logged, not
 * thrown.
 */
export function recordFee(type: FeeType, asset: GlideRecord, returnOrderId: string): void {
    const fee: FeeIdentity = { type, assetId: asset.getUniqueValue(), returnOrderId }
    // A retried step mostly finds the fee charged already: that needs no lock.
    if (isCharged(fee)) return
    const agreement = findById('x_daas_ham_agreement', str(asset, 'x_daas_ham_agreement'))
    const amount = agreement ? num(agreement, AGREEMENT_FEE[type]) : 0
    if (amount <= 0) return
    const attempt = attemptLock(LOCK.fee(fee), (lock) => {
        if (!isCharged(fee)) chargeHolding(lock, fee, asset, amount)
    })
    if (attempt.ran) return
    const why = whyNotRun(attempt, 'left to a run holding its lock, which has not recorded it yet')
    // The holder has normally charged it by now; one that has not may be slow, or have died holding the lock.
    if (isCharged(fee)) return
    log.warn(`${type} fee for ${str(asset, 'serial_number')} not recorded: ${why}; check its Fee events`)
}

function isCharged(fee: FeeIdentity): boolean {
    return exists(FEE, chargedFeeQuery(fee))
}

/**
 * Insert the fee holding `lock`. A holder that outlasts the lock (ADR 0013) may overlap the run that took it over and
 * charges the fee too: one that lost it before the insert leaves the fee to that run, one that lost it during the
 * insert is logged.
 */
function chargeHolding(lock: HeldLock, fee: FeeIdentity, asset: GlideRecord, amount: number): void {
    const record = new GlideRecord(FEE)
    record.initialize()
    record.setValue('fee_type', fee.type)
    record.setValue('customer', str(asset, 'company'))
    record.setValue('agreement', str(asset, 'x_daas_ham_agreement'))
    record.setValue('asset', fee.assetId)
    record.setValue('return_order', fee.returnOrderId)
    record.setValue('amount', amount)
    record.setValue('occurred_on', todayIso())
    const what = `${fee.type} fee for ${str(asset, 'serial_number')}`
    const saved = lock.save(`${what} recorded`, () => record.insert(), { check: 'check it is charged once' })
    if (saved === 'refused') warnRefused(record, `${what} not recorded`)
}

/** Waive the not-yet-billed fees of one type charged for an Asset on a Return order. */
export function waiveOpenFees(type: FeeType, assetId: string, returnOrderId: string): void {
    const fee = new GlideRecord(FEE)
    fee.addQuery('fee_type', type)
    fee.addQuery('asset', assetId)
    fee.addQuery('return_order', returnOrderId)
    fee.addQuery('status', FEE_STATUS.open)
    fee.query()
    while (fee.next()) {
        fee.setValue('status', FEE_STATUS.waived)
        // Left open, it is billed for a unit that came back.
        if (!fee.update()) warnRefused(fee, `${type} fee ${fee.getUniqueValue()} not waived`)
    }
}
