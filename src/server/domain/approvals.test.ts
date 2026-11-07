import { describe, expect, it } from 'vitest'
import { groupDecisions, rollupApprovals } from './approvals'

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
