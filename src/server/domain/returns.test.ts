import { describe, expect, it } from 'vitest'
import { evaluationTarget, feeAmount, overdueStep, returnDueDate, shortfallRoute } from './returns'

describe('returnDueDate', () => {
    it('is the agreement allowance after the return was raised', () => {
        expect(returnDueDate('2026-11-07', 30)).toBe('2026-12-07')
    })
})

describe('overdueStep', () => {
    const due = '2026-12-07'
    it('does nothing before the due date or once received', () => {
        expect(overdueStep({ dueDate: due, today: '2026-12-07', graceDays: 14, received: false, escalated: false })).toBe('none')
        expect(overdueStep({ dueDate: due, today: '2027-02-01', graceDays: 14, received: true, escalated: false })).toBe('none')
    })

    it('escalates once when the due date has passed', () => {
        expect(overdueStep({ dueDate: due, today: '2026-12-08', graceDays: 14, received: false, escalated: false })).toBe('escalate')
        expect(overdueStep({ dueDate: due, today: '2026-12-08', graceDays: 14, received: false, escalated: true })).toBe('none')
    })

    it('declares the asset missing after the grace period', () => {
        expect(overdueStep({ dueDate: due, today: '2026-12-22', graceDays: 14, received: false, escalated: true })).toBe('declare_missing')
    })
})

describe('evaluationTarget', () => {
    it('returns provider-owned units in good order to stock', () => {
        expect(evaluationTarget('refurbish', 'provider')).toBe('available')
        expect(evaluationTarget('refurbish', 'lessor')).toBe('available')
    })

    it('never refurbishes customer-owned units into provider stock', () => {
        expect(evaluationTarget('refurbish', 'customer')).toBe('pending_wipe')
    })

    it('sends defective units to the OEM and scrap or hand-backs to wiping', () => {
        expect(evaluationTarget('oem_rma', 'provider')).toBe('pending_oem_rma')
        expect(evaluationTarget('scrap', 'provider')).toBe('pending_wipe')
        expect(evaluationTarget('return_to_owner', 'lessor')).toBe('pending_wipe')
    })
})

describe('feeAmount', () => {
    it('takes the agreement fee for the event type', () => {
        const fees = { lost: 1500, damaged: 400, late_return: 150 }
        expect(feeAmount('lost', fees)).toBe(1500)
        expect(feeAmount('late_return', fees)).toBe(150)
    })
})

describe('shortfallRoute', () => {
    it('asks the OEM for an advance replacement when a covered unit fails and no stock is left', () => {
        expect(shortfallRoute({ missing: 1, purpose: 'replace', coveredToday: true })).toBe('oem_advance_replacement')
    })

    it('purchases otherwise', () => {
        expect(shortfallRoute({ missing: 1, purpose: 'replace', coveredToday: false })).toBe('purchase')
        expect(shortfallRoute({ missing: 2, purpose: 'new', coveredToday: true })).toBe('purchase')
        expect(shortfallRoute({ missing: 0, purpose: 'replace', coveredToday: true })).toBe('none')
    })
})
