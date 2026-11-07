import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ENDED_UNFULFILLED, replacementStep } from './breakfix'

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

describe('the Raise replacement action', () => {
    const action = readFileSync(new URL('../../fluent/logic/aftersales.now.ts', import.meta.url), 'utf8')
        .split('UiAction({')
        .find((source) => source.includes("actionName: 'x_daas_ham_raise_replacement'"))
    const condition = /condition:\s*"([^"]*)"/.exec(action ?? '')?.[1] ?? ''

    it('is offered again exactly when a linked replacement ended without replacing anything', () => {
        const stages = /\[([^\]]*)\]\.indexOf\(String\(current\.x_daas_ham_replacement_order\.stage\)\)/.exec(condition)?.[1]
        expect(stages?.split(',').map((stage) => stage.trim().replace(/'/g, ''))).toEqual([...ENDED_UNFULFILLED])
        expect(condition).toContain("current.x_daas_ham_replacement_order == ''")
    })
})
