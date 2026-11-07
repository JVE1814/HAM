import { GlideRecord } from '@servicenow/glide'
import { dependentActions, dueStepsQuery, type ClaimAction, type ClaimOutcome, type ClaimStore, type ClaimTarget } from '../domain/oem/claims'
import type { OemVendor } from '../domain/oem/types'
import { num, pluck, str } from './records'
import { memoized } from '../domain/memo'

const STEP = 'x_daas_ham_staging_step'

/** Automated staging steps (x_daas_ham_staging_step) behind the claim run's ClaimStore port; caches OEM cloud accounts per run. */
export function glideClaimStore(): ClaimStore {
    const accounts = memoized(cloudAccount)
    return {
        due: (vendor, action, limit) => dueTargets(vendor, action, limit, accounts),
        settle,
    }
}

/** Up to `limit` due steps (dueStepsQuery), fewest attempts first, then oldest. */
function dueTargets(vendor: OemVendor, action: ClaimAction, limit: number, accounts: (key: string) => string): ClaimTarget[] {
    const step = new GlideRecord(STEP)
    step.addEncodedQuery(dueStepsQuery(vendor, action))
    step.orderBy('attempts')
    step.orderBy('sys_created_on')
    step.orderBy('sys_id')
    step.setLimit(limit)
    step.query()
    const targets: ClaimTarget[] = []
    while (step.next()) {
        const customerId = str(step, 'staging_task.asset.company')
        targets.push({
            stepId: step.getUniqueValue(),
            serial: str(step, 'staging_task.asset.serial_number'),
            mac: str(step, 'staging_task.asset.x_daas_ham_mac_address'),
            claimCode: str(step, 'staging_task.asset.x_daas_ham_claim_code'),
            account: accounts(`${customerId}|${vendor}|${action}`),
        })
    }
    return targets
}

/** A step of `action` on staging task `taskId` was ticked done: the same task's open steps waiting on it are pending. */
export function releaseStepsWaitingOn(taskId: string, action: string): void {
    const dependents = dependentActions(action)
    if (!taskId || dependents.length === 0) return
    const step = new GlideRecord(STEP)
    step.addQuery('staging_task', taskId)
    step.addQuery('automation', 'IN', dependents.join(','))
    step.addQuery('done', false)
    step.addQuery('automation_status', 'waiting')
    step.query()
    while (step.next()) {
        step.setValue('automation_status', 'pending')
        step.update()
    }
}

/** The Customer's OEM cloud account for `action`, looked up once per customer and action. */
function cloudAccount(key: string): string {
    const [customerId, vendor, action] = key.split('|')
    return pluck('x_daas_ham_cloud_account', `customer=${customerId}^vendor=${vendor}^purpose=${action}`, 'account_id', 1)[0] ?? ''
}

/** Tick each step of a run done, or count its failed attempt (it is left for a person after the last one); one query for the run. */
function settle(outcomes: readonly ClaimOutcome[]): void {
    if (outcomes.length === 0) return
    const byStep = new Map<string, ClaimOutcome>(outcomes.map((outcome) => [outcome.stepId, outcome]))
    const step = new GlideRecord(STEP)
    step.addQuery('sys_id', 'IN', [...byStep.keys()].join(','))
    step.query()
    while (step.next()) {
        const outcome = byStep.get(step.getUniqueValue())
        if (!outcome) continue
        step.setValue('automation_message', outcome.message)
        if (outcome.ok) {
            step.setValue('automation_status', 'done')
            step.setValue('done', true)
        } else {
            step.setValue('automation_status', 'failed')
            step.setValue('attempts', num(step, 'attempts') + 1)
        }
        step.update()
    }
}
