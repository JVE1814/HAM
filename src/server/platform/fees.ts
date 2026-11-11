import { GlideRecord, gs } from '@servicenow/glide'
import type { HeldLock } from '../domain/job-lock.ts'
import { LOCK } from '../domain/lock-names.ts'
import { chargedFeeQuery, type FeeIdentity } from '../domain/returns.ts'
import { FEE_STATUS, type FeeType } from '../domain/vocabulary.ts'
import { visitInKeyOrder } from './chunked.ts'
import { todayIso } from './clock.ts'
import { attemptLock, whyNotRun } from './locks.ts'
import { exists, findById, num, refusal, str, warnRefused } from './records.ts'

/**
 * Fee events (x_daas_ham_fee_event): charged and waived by the returns process (P2.4), then put on a Billing period,
 * taken off it again when waived, and marked billed as it closes (plan §13 Billing export). Every write of a Fee event is made here.
 */

const FEE = 'x_daas_ham_fee_event'

/** The Agreement field that holds what a Fee event of each type is charged. */
const AGREEMENT_FEE: Record<FeeType, string> = { lost: 'lost_asset_fee', damaged: 'damage_fee', late_return: 'late_return_fee' }

/**
 * Charge a Fee event of `type` for the Asset on the Return order, once (domain/returns `chargedFeeQuery`): a step
 * retried after a refused save (an evaluation chosen again, a line declared missing again) does not charge it twice.
 * Two runs may also charge it at the same time (two users saving one line's evaluation, overlapping overdue runs; two
 * scans of one unit already take turns under its receive lock, platform/receiving). A unique index on the fee's
 * identity would also refuse a fee charged after a waived one, so the check and the insert are made under a lock on the
 * fee, re-checking there (as platform/exceptions `openException`). A run that finds the lock held through every try (a
 * holder keeps it for one check and one insert, or a generation billing the fee for a read, an insert and a save)
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
    gs.warn(`[x_daas_ham] ${type} fee for ${str(asset, 'serial_number')} not recorded: ${why}; check its Fee events`)
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

/**
 * The open fees a Billing period bills, as a query to walk: those charged up to `lastDay` and on no period yet, or
 * already on this one by a generation its Regenerate rebuilds.
 */
export function billableFees(periodId: string, lastDay: string): GlideRecord {
    const fee = new GlideRecord(FEE)
    fee.addQuery('status', FEE_STATUS.open)
    fee.addEncodedQuery(`billing_periodISEMPTY^ORbilling_period=${periodId}`)
    fee.addQuery('occurred_on', '<=', lastDay)
    fee.query()
    return fee
}

/** What became of a fee a Billing period's generation found billable: billed on it, left to another period, or failed. */
export type FeeBilling = 'billed' | 'left' | { failed: string }

/**
 * Bill a fee `billableFees` found on the period `periodId`: `addLine` adds its billing line (what it throws escapes),
 * and the fee is put on the period. Two generations at once (one month generating as another is regenerated) both find
 * an unlinked fee billable, so the fee is read afresh and billed under its lock, as it is charged: only while it is
 * still open and on no other period, else it is left. A fee whose lock is held through every try (a holder keeps it
 * for one read, one insert and one save) is left when another period has it by then, else it fails.
 */
export function billOnPeriod(fee: GlideRecord, periodId: string, addLine: (fee: GlideRecord) => void): FeeBilling {
    const identity: FeeIdentity = { type: str(fee, 'fee_type') as FeeType, assetId: str(fee, 'asset'), returnOrderId: str(fee, 'return_order') }
    const attempt = attemptLock(LOCK.fee(identity), (): FeeBilling => {
        const current = findById(FEE, fee.getUniqueValue())
        if (!current || !billableOn(current, periodId)) return 'left'
        addLine(current)
        const unlinked = putOnPeriod(current, periodId)
        return unlinked ? { failed: `fee not linked to the period: ${unlinked}` } : 'billed'
    })
    if (attempt.ran) return attempt.value
    const now = findById(FEE, fee.getUniqueValue())
    if (!now || !billableOn(now, periodId)) return 'left'
    return { failed: whyNotRun(attempt, 'another run held its lock through every try') }
}

function billableOn(fee: GlideRecord, periodId: string): boolean {
    const on = str(fee, 'billing_period')
    return str(fee, 'status') === FEE_STATUS.open && (!on || on === periodId)
}

/** Put a fee on the Billing period that bills it; why the platform refused ('' once saved). */
function putOnPeriod(fee: GlideRecord, periodId: string): string {
    fee.setValue('billing_period', periodId)
    return fee.update() ? '' : refusal(fee)
}

/**
 * Visit each fee of a Billing period waived since the period was generated, in sys_id order; a fee `takeOffPeriod`
 * takes off is still visited once.
 */
export function visitWaivedFees(periodId: string, visit: (fee: GlideRecord) => void): void {
    visitInKeyOrder(FEE, `billing_period=${periodId}^status=${FEE_STATUS.waived}`, visit)
}

/** Visit each open fee on a Billing period, in sys_id order; a fee `takeOffPeriod` takes off is still visited once. */
export function visitOpenFees(periodId: string, visit: (fee: GlideRecord) => void): void {
    visitInKeyOrder(FEE, `billing_period=${periodId}^status=${FEE_STATUS.open}`, visit)
}

/** Take a fee off its Billing period; why the platform refused ('' once saved). */
export function takeOffPeriod(fee: GlideRecord): string {
    // Per record: updateMultiple does not reliably clear a reference to empty.
    fee.setValue('billing_period', '')
    return fee.update() ? '' : refusal(fee)
}

/**
 * Mark the open fees of a Billing period billed, as it closes, saving each and checking it. A fee the platform refuses
 * is handed to `refused` with why: left open, it stays on its closed period and is billed by no later one
 * (`billableFees`).
 */
export function markBilled(periodId: string, refused: (fee: GlideRecord, why: string) => void): void {
    const fee = new GlideRecord(FEE)
    fee.addQuery('billing_period', periodId)
    fee.addQuery('status', FEE_STATUS.open)
    fee.query()
    while (fee.next()) {
        fee.setValue('status', FEE_STATUS.billed)
        if (!fee.update()) refused(fee, refusal(fee))
    }
}
