import { describe, expect, it } from 'vitest'
import { approvalAwaited, approversToAsk, groupDecisions, rollupApprovals } from './approvals'

describe('rollupApprovals', () => {
    it('is approved once every required approver group has an approval', () => {
        expect(
            rollupApprovals(['customer_admin', 'account_manager'], [
                { group: 'customer_admin', state: 'approved' },
                { group: 'customer_admin', state: 'requested' },
                { group: 'account_manager', state: 'approved' },
            ]),
        ).toBe('approved')
    })

    it('stays requested while a required group has not approved', () => {
        expect(
            rollupApprovals(['customer_admin', 'account_manager'], [
                { group: 'customer_admin', state: 'approved' },
                { group: 'account_manager', state: 'requested' },
            ]),
        ).toBe('requested')
    })

    it('is rejected as soon as anyone rejects', () => {
        expect(
            rollupApprovals(['customer_admin'], [
                { group: 'customer_admin', state: 'approved' },
                { group: 'customer_admin', state: 'rejected' },
            ]),
        ).toBe('rejected')
    })

    it('is approved when nothing is required', () => {
        expect(rollupApprovals([], [])).toBe('approved')
    })

    it('ignores cancelled approvals', () => {
        expect(rollupApprovals(['customer_admin'], [{ group: 'customer_admin', state: 'cancelled' }])).toBe('requested')
    })
})

describe('groupDecisions', () => {
    it('counts customer admins for the customer-admin group and provider approvers for the account-manager group', () => {
        expect(
            groupDecisions(
                [
                    { approverId: 'ada', state: 'approved' },
                    { approverId: 'am', state: 'requested' },
                ],
                ['ada'],
            ),
        ).toEqual([
            { group: 'customer_admin', state: 'approved' },
            { group: 'account_manager', state: 'requested' },
        ])
    })

    it('lets provider approvers stand in for a customer without customer admins', () => {
        expect(groupDecisions([{ approverId: 'am', state: 'approved' }], [])).toEqual([
            { group: 'account_manager', state: 'approved' },
            { group: 'customer_admin', state: 'approved' },
        ])
    })
})

describe('approversToAsk', () => {
    it('asks nobody when no group must approve', () => {
        expect(approversToAsk([], ['ca'], ['am'])).toEqual([])
    })

    it('asks the customer admins for the customer-admin group', () => {
        expect(approversToAsk(['customer_admin'], ['ca1', 'ca2'], ['am'])).toEqual(['ca1', 'ca2'])
    })

    it('asks the provider approvers in place of the admins of a customer that has none', () => {
        expect(approversToAsk(['customer_admin'], [], ['am'])).toEqual(['am'])
    })

    it('asks the customer admins and the provider approvers when both groups must approve', () => {
        expect(approversToAsk(['customer_admin', 'account_manager'], ['ca'], ['am'])).toEqual(['ca', 'am'])
    })

    it('asks each approver once', () => {
        expect(approversToAsk(['customer_admin', 'account_manager'], [], ['am1', 'am2'])).toEqual(['am1', 'am2'])
        expect(approversToAsk(['customer_admin', 'account_manager'], ['both'], ['both'])).toEqual(['both'])
    })
})

describe('approvalAwaited', () => {
    it('names the group still asked to decide', () => {
        const decisions = [
            { group: 'customer_admin', state: 'approved' },
            { group: 'account_manager', state: 'requested' },
        ] as const
        expect(approvalAwaited(['customer_admin', 'account_manager'], decisions)).toBe(
            'waiting for the account manager (or the asset managers) to decide',
        )
    })

    it('says no approval is still requested from the groups missing one', () => {
        const decisions = [{ group: 'customer_admin', state: 'cancelled' }] as const
        expect(approvalAwaited(['customer_admin', 'account_manager'], decisions)).toBe(
            'no approval from a Customer admin and the account manager (or the asset managers) and none still requested',
        )
    })
})
