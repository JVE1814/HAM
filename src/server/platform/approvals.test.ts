import { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { putToApproval, rollUpApprovals, type ApprovalFlow, type ApprovalRequest } from './approvals.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

/*
 * The approval flow run against in-memory tables: a task (an Order), its sysapproval_approver requests and the
 * Customer admins' roles. What it must keep: a task waits only on requests that could approve it, its outcome is saved
 * before the requests still waiting are cancelled, and a refused save leaves it waiting with them.
 */

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const ORDERS = 'x_daas_ham_order'
const APPROVALS = 'sysapproval_approver'

let orders = 0

/** A saved Order of Customer `acme`, read as a rule or a form button gets it. */
function order(stage: string): GlideRecord {
    const sysId = `order-${++orders}`
    ;(platform.tables[ORDERS] ??= []).push({ sys_id: sysId, number: 'ORD0001', customer: 'acme', stage })
    const record = new GlideRecord(ORDERS)
    record.get(sysId)
    return record
}

function stored(record: GlideRecord): Row {
    return (platform.tables[ORDERS] ?? []).find((row) => row.sys_id === record.getUniqueValue()) ?? {}
}

/** An active user of Customer `acme` who holds the Customer admin role. */
function customerAdmin(userId: string): void {
    ;(platform.tables.sys_user ??= []).push({ sys_id: userId, company: 'acme', active: 'true' })
    ;(platform.tables.sys_user_has_role ??= []).push({ sys_id: `role-of-${userId}`, role: 'customer_admin_role', user: userId, state: 'active' })
}

/** The Order's approval requests as stored: approver -> state. */
function requests(): Record<string, string> {
    return Object.fromEntries((platform.tables[APPROVALS] ?? []).map((row) => [row.approver, row.state]))
}

function decide(approverId: string, state: 'approved' | 'rejected'): void {
    const request = (platform.tables[APPROVALS] ?? []).find((row) => row.approver === approverId)
    if (request) request.state = state
}

/** A request to the Customer admins `customerAdmins` and the provider approver `am` unless `providerApprovers` say otherwise. */
const request = (required: ApprovalRequest['required'], asked: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
    required,
    customerAdmins: ['ca'],
    providerApprovers: ['am'],
    noApprover: 'nobody to approve it',
    ...asked,
})

/** A flow that records what it was asked to decide and saves the outcome as the task's stage. */
function flow(required: ApprovalRequest['required']): ApprovalFlow & { decided: string[] } {
    const decided: string[] = []
    return {
        decided,
        awaitingStage: 'awaiting_approval',
        standIn: 'provider',
        required: () => required,
        decide: (task, outcome) => {
            decided.push(outcome)
            task.setValue('stage', outcome)
            return task.update() ? '' : task.getLastErrorMessage()
        },
    }
}

/** Put `task` to approval for `required` as an Order flow does. */
const put = (task: GlideRecord, required: ApprovalRequest['required'], asked: Partial<ApprovalRequest> = {}) =>
    putToApproval(task, flow(required), request(required, asked))

beforeEach(() => {
    platform.reset()
    platform.references = { 'sys_user_has_role.role': 'sys_user_role', 'sys_user_has_role.user': 'sys_user' }
    platform.tables.sys_user_role = [{ sys_id: 'customer_admin_role', name: 'x_daas_ham.customer_admin' }]
    orders = 0
    customerAdmin('ca')
})

describe('putToApproval', () => {
    it('asks every approver and saves the task as awaiting approval', () => {
        const task = order('draft')

        expect(put(task, ['customer_admin', 'account_manager'])).toEqual({ awaiting: true })

        expect(requests()).toEqual({ ca: 'requested', am: 'requested' })
        expect(stored(task)).toMatchObject({ stage: 'awaiting_approval', approval: 'requested' })
    })

    it('leaves the task as it was when there is nobody to ask', () => {
        const task = order('draft')

        expect(put(task, ['customer_admin'], { customerAdmins: [], providerApprovers: [] })).toEqual({ awaiting: false, step: 'request', reason: 'nobody to approve it' })

        expect(stored(task).stage).toBe('draft')
    })

    it('asks nobody in place of the admins of a Customer that has none when its flow lets nobody stand in', () => {
        const task = order('draft')
        const required = ['customer_admin', 'account_manager'] as const

        const asked = putToApproval(task, { ...flow([...required]), standIn: 'nobody' }, request([...required], { customerAdmins: [] }))

        expect(asked).toEqual({ awaiting: false, step: 'request', reason: 'nobody to approve it' })
        expect(requests()).toEqual({ am: 'cancelled' })
        expect(stored(task).stage).toBe('draft')
    })

    it('takes back the requests that could not approve the task on their own', () => {
        platform.refuses = (table, row) => (table === APPROVALS && row.approver === 'am' && row.state === 'requested' ? 'approver is inactive' : '')
        const task = order('draft')

        const asked = put(task, ['customer_admin', 'account_manager'])

        expect(asked).toEqual({ awaiting: false, step: 'request', reason: 'an approval request was refused: approver is inactive' })
        expect(requests()).toEqual({ ca: 'cancelled' })
        expect(stored(task).stage).toBe('draft')
    })

    it('takes its requests back when the task cannot be saved as awaiting approval', () => {
        platform.refuses = (table) => (table === ORDERS ? 'a rule refused the Order' : '')
        const task = order('draft')

        expect(put(task, ['customer_admin'])).toEqual({ awaiting: false, step: 'save', reason: 'a rule refused the Order' })

        expect(requests()).toEqual({ ca: 'cancelled' })
        expect(stored(task).stage).toBe('draft')
    })
})

describe('rollUpApprovals', () => {
    function awaiting(required: ApprovalRequest['required'], asked: Partial<ApprovalRequest> = {}): GlideRecord {
        const task = order('draft')
        put(task, required, asked)
        return task
    }

    it('leaves a task that is not awaiting approval alone', () => {
        const orderFlow = flow(['customer_admin'])

        expect(rollUpApprovals(order('sourcing'), orderFlow)).toBeNull()
        expect(orderFlow.decided).toEqual([])
    })

    it('decides nothing while a required group has not approved', () => {
        const task = awaiting(['customer_admin', 'account_manager'])
        const orderFlow = flow(['customer_admin', 'account_manager'])
        decide('ca', 'approved')

        expect(rollUpApprovals(task, orderFlow)?.outcome).toBe('requested')

        expect(orderFlow.decided).toEqual([])
        expect(requests()).toEqual({ ca: 'approved', am: 'requested' })
    })

    it('saves the approval once every required group has approved, then cancels the requests still waiting', () => {
        customerAdmin('ca2')
        const task = awaiting(['customer_admin'], { customerAdmins: ['ca', 'ca2'] })
        const orderFlow = flow(['customer_admin'])
        decide('ca', 'approved')

        expect(rollUpApprovals(task, orderFlow)).toMatchObject({ outcome: 'approved', refused: '' })

        expect(orderFlow.decided).toEqual(['approved'])
        expect(requests()).toEqual({ ca: 'approved', ca2: 'cancelled' })
    })

    it('rejects the task on any rejection', () => {
        const task = awaiting(['customer_admin', 'account_manager'])
        const orderFlow = flow(['customer_admin', 'account_manager'])
        decide('am', 'rejected')

        expect(rollUpApprovals(task, orderFlow)).toMatchObject({ outcome: 'rejected', refused: '' })

        expect(orderFlow.decided).toEqual(['rejected'])
        expect(requests()).toEqual({ ca: 'cancelled', am: 'rejected' })
    })

    it('counts the provider approver asked in place of a Customer with no admins for both groups, also once an admin is onboarded', () => {
        platform.tables.sys_user_has_role = []
        const task = order('draft')
        put(task, ['customer_admin', 'account_manager'], { customerAdmins: [] })
        const orderFlow = flow(['customer_admin', 'account_manager'])
        customerAdmin('ca')
        decide('am', 'approved')

        expect(rollUpApprovals(task, orderFlow)?.outcome).toBe('approved')
    })

    it("counts a Customer admin's decision for the admins only, also once their role is removed", () => {
        const task = awaiting(['customer_admin', 'account_manager'])
        const orderFlow = flow(['customer_admin', 'account_manager'])
        platform.tables.sys_user_has_role = []
        decide('ca', 'approved')

        expect(rollUpApprovals(task, orderFlow)?.outcome).toBe('requested')

        expect(orderFlow.decided).toEqual([])
    })

    it('keeps the task awaiting approval with its requests when the outcome cannot be saved', () => {
        const task = awaiting(['customer_admin', 'account_manager'])
        const orderFlow = flow(['customer_admin', 'account_manager'])
        decide('am', 'rejected')
        platform.refuses = (table) => (table === ORDERS ? 'a rule refused the Order' : '')

        expect(rollUpApprovals(task, orderFlow)).toMatchObject({ outcome: 'rejected', refused: 'a rule refused the Order' })

        expect(stored(task).stage).toBe('awaiting_approval')
        expect(requests()).toEqual({ ca: 'requested', am: 'rejected' })
    })
})
