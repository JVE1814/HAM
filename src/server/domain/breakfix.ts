import type { Stage } from './lifecycle.ts'
import { INSTALLED_STAGES } from './returns.ts'
import type { OrderStage } from './vocabulary.ts'

/** Break-fix (P2.3, D58): what "Raise replacement" does on a case that may already link a replacement Order. */

/**
 * - `raise`: no replacement goes ahead for the case, so a new Order is raised and linked;
 * - `submit_draft`: the linked Order was left a draft to correct, so it is submitted again instead of raising another;
 * - `keep`: the linked Order is going ahead or has replaced the Asset, so nothing is raised.
 */
export type ReplacementStep = 'raise' | 'submit_draft' | 'keep'

/**
 * Stages in which an Order ended without replacing anything: a new one may take its place on the case, and the
 * "Raise replacement" action is offered again (its condition lists these stages).
 */
export const ENDED_UNFULFILLED: readonly string[] = ['rejected', 'cancelled']

/** The step for a case whose linked replacement Order is in `linkedStage`, or links none (null, also when it is gone). */
export function replacementStep(linkedStage: OrderStage | null): ReplacementStep {
    if (linkedStage === null || ENDED_UNFULFILLED.includes(linkedStage)) return 'raise'
    return linkedStage === 'draft' ? 'submit_draft' : 'keep'
}

/**
 * Why "Raise replacement" raises no Order for the case's failed Asset, or null when it does: only a fleet asset (ADR
 * 0016) installed at a Site is replaced like-for-like.
 */
export function replacementProblem(failed: { fleet: boolean; stage: Stage | null }): string | null {
    if (!failed.fleet) return 'Only a fleet asset is replaced: the failed asset is not one'
    if (failed.stage === null || !INSTALLED_STAGES.includes(failed.stage)) return 'Only installed assets can be replaced'
    return null
}
