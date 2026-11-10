import { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { putToApproval, rollUpApprovals, type ApprovalFlow, type ApprovalRequest } from './approvals.ts'

/*
 * The approval flow run against in-memory tables: a task (an Order), its sysapproval_approver requests and the
 * Customer admins' roles. What it must keep: a task waits only on requests that could approve it, its outcome is saved
 * before the requests still waiting are cancelled, and a refused save leaves it waiting with them.
 */

type Row = Record<string, string>

const platform = vi.hoisted(() => ({
    tables: {} as Record<string, Array<Record<string, string>>>,
    /** Why a save of `row` to `table` is refused ('' when it is not). */
    refuses: (() => '') as (table: string, row: Record<string, string>) => string,
    ids: 0,
}))

vi.mock('@servicenow/glide', () => {
    const rowsOf = (table: string): Row[] => (platform.tables[table] ??= [])
    class GlideRecord {
        private terms: Array<[string, string]> = []
        private limit = Infinity
        private found: Row[] = []
        private at = -1
        private row: Row = {}
        private error = ''
        constructor(private readonly table: string) {}
        addQuery(field: string, value: string | boolean): void {
            this.terms.push([field, String(value)])
        }
        addEncodedQuery(query: string): void {
            for (const term of query.split('^')) {
                const [field, value] = term.split('=')
                this.terms.push([field ?? '', value ?? ''])
            }
        }
        setLimit(limit: number): void {
            this.limit = limit
        }
        query(): void {
            this.found = rowsOf(this.table)
                .filter((row) => this.terms.every(([field, value]) => (row[field] ?? '') === value))
                .slice(0, this.limit)
            this.at = -1
        }
        hasNext(): boolean {
            return this.at + 1 < this.found.length
        }
        next(): boolean {
            this.at++
            const row = this.found[this.at]
            if (row) this.row = { ...row }
            return row !== undefined
        }
        get(sysId: string): boolean {
            this.addQuery('sys_id', sysId)
            this.query()
            return this.next()
        }
        initialize(): void {
            this.row = {}
        }
        getValue(field: string): string | null {
            return this.row[field] ?? null
        }
        setValue(field: string, value: string | boolean): void {
            this.row[field] = String(value)
        }
        getUniqueValue(): string {
            return this.row.sys_id ?? ''
        }
        getTableName(): string {
            return this.table
        }
        getLastErrorMessage(): string {
            return this.error
        }
        insert(): string | null {
            this.error = platform.refuses(this.table, this.row)
            if (this.error) return null
            this.row.sys_id = `${this.table}-${++platform.ids}`
            rowsOf(this.table).push({ ...this.row })
            return this.row.sys_id
        }
        update(): string | null {
            this.error = platform.refuses(this.table, this.row)
            if (this.error) return null
            Object.assign(rowsOf(this.table).find((row) => row.sys_id === this.row.sys_id) ?? {}, this.row)
            return this.row.sys_id ?? null
        }
    }
    return { GlideRecord, GlideAggregate: class {}, gs: { warn: () => undefined } }
})

const ORDERS = 'x_daas_ham_order'
const APPROVALS = 'sysapproval_approver'

/** A saved Order of Customer `acme`, read as a rule or a form button gets it. */
function order(stage: string): GlideRecord {
    const sysId = `order-${++platform.ids}`
    ;(platform.tables[ORDERS] ??= []).push({ sys_id: sysId, number: 'ORD0001', customer: 'acme', stage })
    const record = new GlideRecord(ORDERS)
    record.get(sysId)
    return record
}

function stored(record: GlideRecord): Row {
    return (platform.tables[ORDERS] ?? []).find((row) => row.sys_id === record.getUniqueValue()) ?? {}
}

function customerAdmin(userId: string): void {
    const role = { 'role.name': 'x_daas_ham.customer_admin', 'user.company': 'acme', 'user.active': 'true', state: 'active', user: userId }
    ;(platform.tables.sys_user_has_role ??= []).push(role)
}

/** The Order's approval requests as stored: approver -> state. */
function requests(): Record<string, string> {
    return Object.fromEntries((platform.tables[APPROVALS] ?? []).map((row) => [row.approver, row.state]))
}

function decide(approverId: string, state: 'approved' | 'rejected'): void {
    const request = (platform.tables[APPROVALS] ?? []).find((row) => row.approver === approverId)
    if (request) request.state = state
}

const request = (approverIds: string[], required: ApprovalRequest['required']): ApprovalRequest => ({
    awaitingStage: 'awaiting_approval',
    approverIds,
    required,
    customerAdmins: ['ca'],
    noApprover: 'nobody to approve it',
})

beforeEach(() => {
    platform.tables = {}
    platform.refuses = () => ''
    platform.ids = 0
    customerAdmin('ca')
})

describe('putToApproval', () => {
    it('asks every approver and saves the task as awaiting approval', () => {
        const task = order('draft')

        expect(putToApproval(task, request(['ca', 'am'], ['customer_admin', 'account_manager']))).toEqual({ awaiting: true })

        expect(requests()).toEqual({ ca: 'requested', am: 'requested' })
        expect(stored(task)).toMatchObject({ stage: 'awaiting_approval', approval: 'requested' })
    })

    it('leaves the task as it was when there is nobody to ask', () => {
        const task = order('draft')

        expect(putToApproval(task, request([], ['customer_admin']))).toEqual({ awaiting: false, step: 'request', reason: 'nobody to approve it' })

        expect(stored(task).stage).toBe('draft')
    })

    it('takes back the requests that could not approve the task on their own', () => {
        platform.refuses = (table, row) => (table === APPROVALS && row.approver === 'am' && row.state === 'requested' ? 'approver is inactive' : '')
        const task = order('draft')

        const asked = putToApproval(task, request(['ca', 'am'], ['customer_admin', 'account_manager']))

        expect(asked).toEqual({ awaiting: false, step: 'request', reason: 'an approval request was refused: approver is inactive' })
        expect(requests()).toEqual({ ca: 'cancelled' })
        expect(stored(task).stage).toBe('draft')
    })

    it('takes its requests back when the task cannot be saved as awaiting approval', () => {
        platform.refuses = (table) => (table === ORDERS ? 'a rule refused the Order' : '')
        const task = order('draft')

        expect(putToApproval(task, request(['ca'], ['customer_admin']))).toEqual({ awaiting: false, step: 'save', reason: 'a rule refused the Order' })

        expect(requests()).toEqual({ ca: 'cancelled' })
        expect(stored(task).stage).toBe('draft')
    })
})

describe('rollUpApprovals', () => {
    /** A flow that records what it was asked to decide and saves the outcome as the task's stage. */
    function flow(required: ApprovalRequest['required']): ApprovalFlow & { decided: string[] } {
        const decided: string[] = []
        return {
            decided,
            awaitingStage: 'awaiting_approval',
            required: () => required,
            decide: (task, outcome) => {
                decided.push(outcome)
                task.setValue('stage', outcome)
                return task.update() ? '' : task.getLastErrorMessage()
            },
        }
    }

    function awaiting(approverIds: string[], required: ApprovalRequest['required']): GlideRecord {
        const task = order('draft')
        putToApproval(task, request(approverIds, required))
        return task
    }

    it('leaves a task that is not awaiting approval alone', () => {
        const orderFlow = flow(['customer_admin'])

        expect(rollUpApprovals(order('sourcing'), orderFlow)).toBeNull()
        expect(orderFlow.decided).toEqual([])
    })

    it('decides nothing while a required group has not approved', () => {
        const task = awaiting(['ca', 'am'], ['customer_admin', 'account_manager'])
        const orderFlow = flow(['customer_admin', 'account_manager'])
        decide('ca', 'approved')

        expect(rollUpApprovals(task, orderFlow)?.outcome).toBe('requested')

        expect(orderFlow.decided).toEqual([])
        expect(requests()).toEqual({ ca: 'approved', am: 'requested' })
    })

    it('saves the approval once every required group has approved, then cancels the requests still waiting', () => {
        customerAdmin('ca2')
        const task = awaiting(['ca', 'ca2'], ['customer_admin'])
        const orderFlow = flow(['customer_admin'])
        decide('ca', 'approved')

        expect(rollUpApprovals(task, orderFlow)).toMatchObject({ outcome: 'approved', refused: '' })

        expect(orderFlow.decided).toEqual(['approved'])
        expect(requests()).toEqual({ ca: 'approved', ca2: 'cancelled' })
    })

    it('rejects the task on any rejection', () => {
        const task = awaiting(['ca', 'am'], ['customer_admin', 'account_manager'])
        const orderFlow = flow(['customer_admin', 'account_manager'])
        decide('am', 'rejected')

        expect(rollUpApprovals(task, orderFlow)).toMatchObject({ outcome: 'rejected', refused: '' })

        expect(orderFlow.decided).toEqual(['rejected'])
        expect(requests()).toEqual({ ca: 'cancelled', am: 'rejected' })
    })

    it('keeps the task awaiting approval with its requests when the outcome cannot be saved', () => {
        const task = awaiting(['ca', 'am'], ['customer_admin', 'account_manager'])
        const orderFlow = flow(['customer_admin', 'account_manager'])
        decide('am', 'rejected')
        platform.refuses = (table) => (table === ORDERS ? 'a rule refused the Order' : '')

        expect(rollUpApprovals(task, orderFlow)).toMatchObject({ outcome: 'rejected', refused: 'a rule refused the Order' })

        expect(stored(task).stage).toBe('awaiting_approval')
        expect(requests()).toEqual({ ca: 'requested', am: 'rejected' })
    })
})
