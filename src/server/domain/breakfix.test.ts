import { describe, expect, it } from 'vitest'
import { replacementStep } from './breakfix'

describe('replacementStep', () => {
    it('raises a replacement for a case that links none', () => {
        expect(replacementStep(null)).toBe('raise')
    })

    it('submits the linked draft again instead of raising a second replacement', () => {
        expect(replacementStep('draft')).toBe('submit_draft')
    })

    it('keeps a linked replacement that is going ahead or complete', () => {
        for (const stage of ['awaiting_approval', 'sourcing', 'preparing', 'delivering', 'installing', 'complete']) {
            expect(replacementStep(stage)).toBe('keep')
        }
    })

    it('raises a new replacement in place of one rejected or cancelled', () => {
        expect(replacementStep('rejected')).toBe('raise')
        expect(replacementStep('cancelled')).toBe('raise')
    })
})
