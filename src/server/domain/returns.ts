import { addDays } from './calendar'
import type { LegalOwner, Stage } from './lifecycle'

/** Returns, depot evaluation, Fee events and break-fix shortfalls (P2.3–P2.4). */

export function returnDueDate(raisedOn: string, allowanceDays: number): string {
    return addDays(raisedOn, allowanceDays)
}

export type OverdueStep = 'none' | 'escalate' | 'declare_missing'

/** What to do about an unreturned Asset today: escalate once after the due date, declare it missing after the grace period. */
export function overdueStep(input: { dueDate: string; today: string; graceDays: number; received: boolean; escalated: boolean }): OverdueStep {
    if (input.received || input.today <= input.dueDate) return 'none'
    if (input.today > addDays(input.dueDate, input.graceDays)) return 'declare_missing'
    return input.escalated ? 'none' : 'escalate'
}

export type EvaluationOutcome = 'refurbish' | 'oem_rma' | 'scrap' | 'return_to_owner'

/** Where a returned Asset goes after depot evaluation. Customer-owned units never join provider stock. */
export function evaluationTarget(outcome: EvaluationOutcome, legalOwner: LegalOwner): Stage {
    switch (outcome) {
        case 'refurbish':
            return legalOwner === 'customer' ? 'pending_wipe' : 'available'
        case 'oem_rma':
            return 'pending_oem_rma'
        case 'scrap':
        case 'return_to_owner':
            return 'pending_wipe'
    }
}

export type FeeType = 'lost' | 'damaged' | 'late_return'

export function feeAmount(type: FeeType, agreementFees: Record<FeeType, number>): number {
    return agreementFees[type]
}

export type ShortfallRoute = 'none' | 'purchase' | 'oem_advance_replacement'

/** A covered unit that fails with no stock left is replaced by the OEM in advance; anything else is purchased. */
export function shortfallRoute(input: { missing: number; purpose: 'new' | 'replace'; coveredToday: boolean }): ShortfallRoute {
    if (input.missing <= 0) return 'none'
    return input.purpose === 'replace' && input.coveredToday ? 'oem_advance_replacement' : 'purchase'
}
