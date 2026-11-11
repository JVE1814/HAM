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
                'provider',
            ),
        ).toEqual([
            { group: 'customer_admin', state: 'approved' },
            { group: 'account_manager', state: 'requested' },
        ])
    })

    it('lets provider approvers stand in for a customer without customer admins', () => {
        expect(groupDecisions([{ approverId: 'am', state: 'approved' }], [], 'provider')).toEqual([
            { group: 'account_manager', state: 'approved' },
            { group: 'customer_admin', state: 'approved' },
        ])
    })

    it('counts provider approvers for their own group only where nobody stands in for the admins', () => {
        expect(groupDecisions([{ approverId: 'am', state: 'approved' }], [], 'nobody')).toEqual([{ group: 'account_manager', state: 'approved' }])
    })
})

describe('approversToAsk', () => {
    it('asks nobody when no group must approve', () => {
        expect(approversToAsk([], ['ca'], ['am'], 'provider')).toEqual([])
    })

    it('asks the customer admins for the customer-admin group', () => {
        expect(approversToAsk(['customer_admin'], ['ca1', 'ca2'], ['am'], 'provider')).toEqual(['ca1', 'ca2'])
    })

    it('asks the provider approvers in place of the admins of a customer that has none', () => {
        expect(approversToAsk(['customer_admin'], [], ['am'], 'provider')).toEqual(['am'])
    })

    it('asks nobody for the admins of a customer that has none where nobody stands in for them', () => {
        expect(approversToAsk(['customer_admin'], [], ['am'], 'nobody')).toEqual([])
        expect(approversToAsk(['customer_admin', 'account_manager'], [], ['am'], 'nobody')).toEqual(['am'])
    })

    it('asks the customer admins and the provider approvers when both groups must approve', () => {
        expect(approversToAsk(['customer_admin', 'account_manager'], ['ca'], ['am'], 'provider')).toEqual(['ca', 'am'])
    })

    it('asks each approver once', () => {
        expect(approversToAsk(['customer_admin', 'account_manager'], [], ['am1', 'am2'], 'provider')).toEqual(['am1', 'am2'])
        expect(approversToAsk(['customer_admin', 'account_manager'], ['both'], ['both'], 'provider')).toEqual(['both'])
    })
})

describe('approvalAwaited', () => {
    const names = { customer_admin: 'a Customer admin', account_manager: 'the account manager' }

    it('names the group still asked to decide', () => {
        const decisions = [
            { group: 'customer_admin', state: 'approved' },
            { group: 'account_manager', state: 'requested' },
        ] as const
        expect(approvalAwaited(['customer_admin', 'account_manager'], decisions, names)).toBe(
            'waiting for the account manager to decide',
        )
    })

    it('says no approval is still requested from the groups missing one', () => {
        const decisions = [{ group: 'customer_admin', state: 'cancelled' }] as const
        expect(approvalAwaited(['customer_admin', 'account_manager'], decisions, names)).toBe(
            'no approval from a Customer admin and the account manager and none still requested',
        )
    })
})
