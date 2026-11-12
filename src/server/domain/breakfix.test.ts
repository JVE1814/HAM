import { describe, expect, it } from 'vitest'
import { replacementProblem, replacementStep } from './breakfix'

describe('replacementStep', () => {
    it('raises a replacement for a case that links none', () => {
        expect(replacementStep(null)).toBe('raise')
    })

    it('submits the linked draft again instead of raising a second replacement', () => {
        expect(replacementStep('draft')).toBe('submit_draft')
    })

    it('keeps a linked replacement that is going ahead or complete', () => {
        for (const stage of ['awaiting_approval', 'sourcing', 'preparing', 'delivering', 'installing', 'complete'] as const) {
            expect(replacementStep(stage)).toBe('keep')
        }
    })

    it('raises a new replacement in place of one rejected or cancelled', () => {
        expect(replacementStep('rejected')).toBe('raise')
        expect(replacementStep('cancelled')).toBe('raise')
    })
})

describe('replacementProblem', () => {
    it('replaces no equipment outside the fleet, whatever its stage', () => {
        expect(replacementProblem({ fleet: false, stage: 'in_service' })).toBe('Only a fleet asset is replaced: the failed asset is not one')
    })

    it('replaces an installed fleet asset', () => {
        for (const stage of ['in_service', 'temporary_deployment', 'pending_in_service'] as const) {
            expect(replacementProblem({ fleet: true, stage })).toBeNull()
        }
    })

    it('replaces no fleet asset that is not installed', () => {
        for (const stage of ['available', 'staged', 'shipped', 'pending_return', 'pending_evaluation', null] as const) {
            expect(replacementProblem({ fleet: true, stage })).toBe('Only installed assets can be replaced')
        }
    })
})
