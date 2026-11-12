import { UNFULFILLED_ORDER_STAGES } from './fulfilment.ts'
import { INSTALLED_STAGES, type Stage } from './lifecycle.ts'
import type { OrderStage } from './vocabulary.ts'

/**
 * - `raise`: no replacement goes ahead for the case, so a new Order is raised and linked;
 * - `submit_draft`: the linked Order was left a draft to correct, so it is submitted again instead of raising another;
 * - `keep`: the linked Order is going ahead or has replaced the Asset, so nothing is raised.
 */
export type ReplacementStep = 'raise' | 'submit_draft' | 'keep'

/**
 * The step for a case whose linked replacement Order is in `linkedStage`, or links none (null, also when it is gone).
 * An Order that ended without replacing anything gives way to a new one, and "Raise replacement" is offered again.
 */
export function replacementStep(linkedStage: OrderStage | null): ReplacementStep {
    if (linkedStage === null || UNFULFILLED_ORDER_STAGES.includes(linkedStage)) return 'raise'
    return linkedStage === 'draft' ? 'submit_draft' : 'keep'
}

/**
 * Whether the failed Asset a case names is another Customer's than the case's account. A case with no account yet
 * takes the Asset's Customer (platform/breakfix `takeFailedAssetTerms`), so it is never another's.
 */
export function isAnotherCustomers(caseAccountId: string, assetCustomerId: string): boolean {
    return caseAccountId !== '' && caseAccountId !== assetCustomerId
}

/**
 * Why "Raise replacement" raises no Order for the case's failed Asset, or null when it does: only a fleet asset (ADR
 * 0016) installed at a Site is replaced like-for-like, and only for the Customer the case is about: the Order is
 * raised for the Asset's Customer, at its Site.
 */
export function replacementProblem(failed: { fleet: boolean; stage: Stage | null; customerId: string }, caseAccountId: string): string | null {
    if (!failed.fleet) return 'Only a fleet asset is replaced: the failed asset is not one'
    if (isAnotherCustomers(caseAccountId, failed.customerId)) return "The failed asset is not the case account's: set the account or the failed asset right first"
    if (failed.stage === null || !INSTALLED_STAGES.includes(failed.stage)) return 'Only installed assets can be replaced'
    return null
}
