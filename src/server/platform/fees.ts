import { GlideRecord } from '@servicenow/glide'
import { chargedFeeQuery, type FeeIdentity, openFeeQuery } from '../domain/fees.ts'
import type { HeldLock } from '../domain/job-lock.ts'
import { LOCK } from '../domain/lock-names.ts'
import { BILLING_PERIOD_STATUS, FEE_STATUS, type FeeType } from '../domain/vocabulary.ts'
import { todayIso } from './clock.ts'
import { attemptLock, whyNotRun } from './locks.ts'
import { log } from './log.ts'
import { exists, findById, num, str, warnRefused } from './records.ts'

/**
 * Fee events (x_daas_ham_fee_event) as the returns process (P2.4) charges and waives them. A Billing period puts them on
 * itself, takes them off and marks them billed (platform/billing).
 */

const FEE = 'x_daas_ham_fee_event'
const PERIOD = 'x_daas_ham_billing_period'

const AGREEMENT_FEE: Record<FeeType, string> = { lost: 'lost_asset_fee', damaged: 'damage_fee', late_return: 'late_return_fee' }

/**
 * Charge a Fee event of `type` for the Asset on the Return order, once: a step
 * retried after a refused save (an evaluation chosen again, a line declared missing again) does not charge it twice.
 * Two runs may also charge it at the same time (two users saving one line's evaluation, overlapping overdue runs; two
 * scans of one unit already take turns under its receive lock, platform/receiving). A unique index on the fee's
 * identity would also refuse a fee charged after a waived one, so the check and the insert are made under a lock on the
 * fee, re-checking there (as platform/exceptions `openException`). A run that finds the lock held through every try
 * leaves the fee to the holder, which is charging it unless it is billing one charged already. A fee that is
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

/** The identity a fee record was charged under (`chargeHolding`): what names its lock while it is charged or billed. */
export function feeIdentityOf(fee: GlideRecord): FeeIdentity {
    return { type: str(fee, 'fee_type') as FeeType, assetId: str(fee, 'asset'), returnOrderId: str(fee, 'return_order') }
}

/**
 * Waive the not-yet-billed charges of `identity`. A generation puts a charge on its Billing period under the fee's lock,
 * and a Close takes waived charges off its period and marks the open ones billed under the period's (ADR 0013). So the
 * charges are read under the fee's lock, and one on a period is waived under that period's lock too, only while the
 * period is not closed: a waiver saved in the middle of a Close would stay on the closed bill, or be overwritten as
 * billed. A charge left open is billed for a unit that came back, so it is logged as an error to settle by hand.
 */
export function waiveOpenFees(identity: FeeIdentity): void {
    const attempt = attemptLock(LOCK.fee(identity), () => {
        const fee = new GlideRecord(FEE)
        fee.addEncodedQuery(openFeeQuery(identity))
        fee.query()
        while (fee.next()) waiveHolding(fee, `${identity.type} fee ${fee.getUniqueValue()}`)
    })
    if (attempt.ran) return
    const why = whyNotRun(attempt, 'a run billing it holds its lock')
    log.error(`${identity.type} fee of Asset ${identity.assetId} on Return order ${identity.returnOrderId} not waived: ${why}; waive it by hand`)
}

/** Waive the open charge `fee`, read holding its lock: under its Billing period's lock too when it is on one. */
function waiveHolding(fee: GlideRecord, what: string): void {
    const periodId = str(fee, 'billing_period')
    if (!periodId) return saveWaived(fee, what)
    const attempt = attemptLock(LOCK.billingPeriod(periodId), () => {
        const period = findById(PERIOD, periodId)
        if (!period || str(period, 'status') !== BILLING_PERIOD_STATUS.closed) return saveWaived(fee, what)
        log.error(`${what} not waived: Billing period ${str(period, 'period')} bills it and is closed; credit it by hand`)
    })
    if (attempt.ran) return
    const why = whyNotRun(attempt, "its Billing period's lock is held (a Close, a Regenerate or another waiver)")
    log.error(`${what} not waived: ${why}; waive it by hand, or credit it if its period is closed by then`)
}

function saveWaived(fee: GlideRecord, what: string): void {
    fee.setValue('status', FEE_STATUS.waived)
    if (!fee.update()) warnRefused(fee, `${what} not waived`)
}
