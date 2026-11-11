import { describe, expect, it } from 'vitest'
import {
    assetLifecycleStamp,
    INSTALLED_PAST_SUPPORT,
    backwardsMilestones,
    mergeLifecycle,
    MILESTONE_ROW_CHANGED,
    OWN_MILESTONE_ROWS,
    parseLifecycleRow,
    PAST_SUPPORT_PHASES,
    type AssetLifecycleFacts,
    type LifecycleDates,
} from './model-lifecycle'
import type { RefreshBasis } from './vocabulary'

const cisco = {
    endOfSale: '2024-04-30',
    endOfSupport: '2029-04-30',
    endOfExtendedSupport: undefined,
    endOfLife: '2029-04-30',
}

describe('assetLifecycleStamp', () => {
    const inService: AssetLifecycleFacts = { refreshBasis: 'cycle', inServiceDate: '2026-03-31', refreshCycleMonths: 36 }
    const shipped: AssetLifecycleFacts = { refreshBasis: 'cycle', refreshCycleMonths: 36 }
    const returned = { endAction: 'return', ends: '2027-06-30' } as const
    const refreshDue = (asset: AssetLifecycleFacts, model: LifecycleDates = {}) => assetLifecycleStamp(asset, model, '2026-11-07').refreshDue

    it("gives the Model's Lifecycle phase and the Asset's Refresh due date", () => {
        expect(assetLifecycleStamp(inService, cisco, '2026-11-07')).toEqual({ phase: 'end_of_sale', refreshDue: '2029-03-31' })
    })

    it('is available before any milestone', () => {
        expect(assetLifecycleStamp(inService, cisco, '2024-01-01').phase).toBe('available')
    })

    it('is in the latest milestone reached on the given day', () => {
        expect(assetLifecycleStamp(inService, cisco, '2024-04-30').phase).toBe('end_of_sale')
        expect(assetLifecycleStamp(inService, cisco, '2030-01-01').phase).toBe('end_of_life')
    })

    it('treats a model without milestones as available', () => {
        expect(assetLifecycleStamp(inService, {}, '2030-01-01').phase).toBe('available')
    })

    it('adds the refresh cycle to the in-service date', () => {
        expect(refreshDue(inService)).toBe('2029-03-31')
    })

    it('uses end of support when the agreement refreshes on support', () => {
        expect(refreshDue({ ...inService, refreshBasis: 'end_of_support' }, { endOfSupport: '2028-01-31' })).toBe('2028-01-31')
    })

    it('takes whichever comes first', () => {
        expect(refreshDue({ ...inService, refreshBasis: 'earliest' }, { endOfSupport: '2030-01-31' })).toBe('2029-03-31')
        expect(refreshDue({ ...inService, refreshBasis: 'earliest' }, { endOfSupport: '2028-01-31' })).toBe('2028-01-31')
    })

    it('refreshes an asset without an agreement at end of support', () => {
        expect(refreshDue({ refreshBasis: '', inServiceDate: '2026-03-31', refreshCycleMonths: 0 }, cisco)).toBe('2029-04-30')
    })

    it('brings the date forward to a lease hand-back, whatever the basis', () => {
        expect(refreshDue({ ...inService, lease: returned })).toBe('2027-06-30')
        expect(refreshDue({ ...inService, refreshCycleMonths: 0, lease: returned })).toBe('2027-06-30')
        expect(refreshDue({ ...inService, refreshBasis: 'end_of_support', lease: returned }, cisco)).toBe('2027-06-30')
        expect(refreshDue({ ...inService, lease: { endAction: 'return', ends: '2027-06-30 00:00:00' } })).toBe('2027-06-30')
    })

    it('keeps the basis date when the lease ends later', () => {
        expect(refreshDue({ ...inService, refreshCycleMonths: 12, lease: returned })).toBe('2027-03-31')
    })

    it('applies a lease hand-back before the asset is in service', () => {
        expect(refreshDue({ ...shipped, lease: returned }, cisco)).toBe('2027-06-30')
    })

    it('caps at the lease end only once the decision is to return it', () => {
        for (const endAction of ['extend', 'buyout', 'undecided', ''] as const) {
            expect(refreshDue({ ...inService, lease: { endAction, ends: '2027-06-30' } }), endAction).toBe('2029-03-31')
        }
        expect(refreshDue({ ...inService, lease: { endAction: 'return', ends: '' } })).toBe('2029-03-31')
    })

    it('gives only the lease cap for a refresh basis stored past the list', () => {
        const refreshBasis = 'quarterly' as RefreshBasis
        expect(refreshDue({ ...inService, refreshBasis, lease: returned }, cisco)).toBe('2027-06-30')
        expect(refreshDue({ ...inService, refreshBasis }, cisco)).toBe('')
    })

    it('has no due date for an asset not yet in service or without the needed data', () => {
        expect(refreshDue(shipped, cisco)).toBe('')
        expect(refreshDue({ ...inService, refreshBasis: 'end_of_support' })).toBe('')
        expect(refreshDue({ ...inService, refreshCycleMonths: 0 })).toBe('')
        expect(refreshDue({ refreshBasis: '', inServiceDate: '2026-03-31', refreshCycleMonths: 0 })).toBe('')
    })
})

describe('parseLifecycleRow', () => {
    it('reads ISO milestone dates and leaves blanks out', () => {
        expect(parseLifecycleRow({ pid: 'C9300-48P-E', endOfSale: '2024-04-30', endOfSupport: ' 2029-04-30 ', endOfExtendedSupport: '', endOfLife: '' })).toEqual({
            ok: true,
            pid: 'C9300-48P-E',
            dates: { endOfSale: '2024-04-30', endOfSupport: '2029-04-30' },
        })
    })

    it('reads a row with no date, PID or not, as one with nothing to import', () => {
        expect(parseLifecycleRow({ pid: '', endOfSale: ' ' })).toEqual({ ok: true, pid: '', dates: {} })
        expect(parseLifecycleRow({ pid: 'X' })).toEqual({ ok: true, pid: 'X', dates: {} })
    })

    it('rejects rows without a PID or with malformed dates', () => {
        expect(parseLifecycleRow({ pid: ' ', endOfSale: '2024-04-30' })).toEqual({ ok: false, reason: 'PID is required' })
        expect(parseLifecycleRow({ pid: 'X', endOfSupport: '30/04/2029' })).toEqual({ ok: false, reason: 'endOfSupport must be YYYY-MM-DD' })
    })

    it('rejects a milestone on a day the month does not have instead of rolling it into the next month', () => {
        expect(parseLifecycleRow({ pid: 'X', endOfSupport: '2026-02-31' })).toEqual({ ok: false, reason: 'endOfSupport must be YYYY-MM-DD' })
    })

})

describe('backwardsMilestones', () => {
    it('says which milestone comes after the next one given, skipping those not given', () => {
        expect(backwardsMilestones({ endOfSale: '2030-01-01', endOfSupport: '2029-01-01' })).toBe(
            'Milestones must not go backwards (end of sale after end of support)',
        )
        expect(backwardsMilestones({ endOfSupport: '2030-01-01', endOfLife: '2029-01-01' })).toBe(
            'Milestones must not go backwards (end of support after end of life)',
        )
    })

    it('passes milestones in order, on the same day or with gaps', () => {
        expect(backwardsMilestones({ endOfSale: '2025-06-30', endOfSupport: '2030-06-30', endOfLife: '2030-06-30' })).toBe('')
        expect(backwardsMilestones({})).toBe('')
    })
})

describe('mergeLifecycle', () => {
    it('lets newer data fill or replace milestones but never erase them', () => {
        expect(
            mergeLifecycle({ endOfSale: '2024-01-31', endOfSupport: '2029-01-31' }, { endOfSupport: '2029-06-30', endOfLife: undefined }),
        ).toEqual({ endOfSale: '2024-01-31', endOfSupport: '2029-06-30', endOfExtendedSupport: undefined, endOfLife: undefined })
    })
})

describe('PAST_SUPPORT_PHASES', () => {
    it('are the phases INSTALLED_PAST_SUPPORT selects', () => {
        expect(INSTALLED_PAST_SUPPORT).toContain(`^x_daas_ham_lifecycle_phaseIN${PAST_SUPPORT_PHASES.join(',')}^`)
    })
})

describe('MILESTONE_ROW_CHANGED', () => {
    it("holds for a change of every field the app reads a Model's milestones by", () => {
        const read = `${OWN_MILESTONE_ROWS}^start_dateISNOTEMPTY^model=model1`
        const fields = read.split('^').map((term) => /^[a-z_]+?(?==|IN|ISNOTEMPTY)/.exec(term)?.[0])
        expect(fields).not.toContain(undefined)
        for (const field of new Set(fields)) expect(MILESTONE_ROW_CHANGED).toContain(`current.${field}.changes()`)
    })
})
