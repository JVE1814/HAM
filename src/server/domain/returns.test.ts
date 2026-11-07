import { describe, expect, it } from 'vitest'
import { evaluationTarget, feeAmount, overdueStep, returnDueDate, shortfallOutcome, shortfallRoute } from './returns'

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

describe('shortfallOutcome', () => {
    const line = { planSummary: '1 from central stock, 2 to purchase', missing: 2, onOrder: 3 }

    it('sources a line with nothing left to buy as planned', () => {
        expect(shortfallOutcome({ route: 'none' }, { ...line, missing: 0 })).toEqual({ stage: 'sourced', summary: line.planSummary, quantityToPurchase: 3 })
    })

    it('notes an OEM advance replacement without buying anything', () => {
        expect(shortfallOutcome({ route: 'oem_advance_replacement' }, { ...line, missing: 1 })).toEqual({
            stage: 'sourced',
            summary: '1 from central stock, 2 to purchase (OEM advance replacement under RMA)',
            quantityToPurchase: 3,
        })
    })

    it('links the purchase order created and counts its units on top of those already on order', () => {
        expect(shortfallOutcome({ route: 'purchase', purchase: { ok: true, poId: 'po1' } }, line)).toEqual({
            stage: 'sourced',
            summary: line.planSummary,
            purchaseOrder: 'po1',
            quantityToPurchase: 5,
        })
    })

    it('leaves the line waiting for stock, saying why, when no purchase order was created', () => {
        const purchase = { ok: false, reason: 'set x_daas_ham.staging.default_stockroom' } as const
        expect(shortfallOutcome({ route: 'purchase', purchase }, line)).toEqual({
            stage: 'awaiting_stock',
            summary: '1 from central stock, 2 to purchase (no purchase order: set x_daas_ham.staging.default_stockroom)',
            quantityToPurchase: 3,
        })
    })
})
