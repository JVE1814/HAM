import { describe, expect, it } from 'vitest'
import { PAST_SUPPORT_PHASES } from './model-lifecycle'
import { supportRisk } from './support-risk'

describe('supportRisk', () => {
    const today = '2026-11-07'
    const safe = { lifecyclePhase: 'available', coverageEnd: '2028-01-01', refreshDue: '2029-01-01' } as const

    it('is low for a supported, covered device whose refresh is far off', () => {
        expect(supportRisk(safe, today)).toBe('low')
        expect(supportRisk({ ...safe, lifecyclePhase: '', refreshDue: '' }, today)).toBe('low')
    })

    it('is high once the Model is past its end of support', () => {
        for (const lifecyclePhase of PAST_SUPPORT_PHASES) expect(supportRisk({ ...safe, lifecyclePhase }, today), lifecyclePhase).toBe('high')
    })

    it('is high without OEM coverage today', () => {
        expect(supportRisk({ ...safe, coverageEnd: '' }, today)).toBe('high')
        expect(supportRisk({ ...safe, coverageEnd: '2026-11-06' }, today)).toBe('high')
        expect(supportRisk({ ...safe, coverageEnd: today }, today)).toBe('low')
    })

    it('is medium past the end of sale, or with a refresh due within 180 days', () => {
        expect(supportRisk({ ...safe, lifecyclePhase: 'end_of_sale' }, today)).toBe('medium')
        expect(supportRisk({ ...safe, refreshDue: '2027-05-05' }, today)).toBe('medium')
        expect(supportRisk({ ...safe, refreshDue: '2027-05-06' }, today)).toBe('low')
        expect(supportRisk({ ...safe, refreshDue: '2026-01-01' }, today)).toBe('medium')
    })
})
