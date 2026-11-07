import { GlideRecord } from '@servicenow/glide'
import {
    CLAIM_PREREQUISITE,
    dependentActions,
    dueStepsQuery,
    isExhausted,
    MAX_CLAIM_ATTEMPTS,
    openStepsQuery,
    PARKED_MESSAGE,
    readyTargets,
    type ClaimAction,
    type ClaimOutcome,
    type ClaimStore,
    type ClaimTarget,
} from '../domain/oem/claims'
import type { OemVendor } from '../domain/oem/types'
import { findById, num, str } from './records'
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

/** Candidate pages read past steps that wait on a prerequisite, so waiting steps cannot starve ready ones. */
const CANDIDATE_PAGES = 5
const PAGE_SIZE = 200

/**
 * Up to `limit` due steps. For an action with a prerequisite, each page of candidates is checked
 * against open prerequisite steps of the same tasks (one bounded query per page), and the limit counts
 * only ready steps; waiting steps are not loaded as targets, so they use no attempts.
 */
function dueTargets(vendor: OemVendor, action: ClaimAction, limit: number, accounts: (key: string) => string): ClaimTarget[] {
    const prerequisite = CLAIM_PREREQUISITE[action]
    if (!prerequisite) return candidatePage(vendor, action, 0, limit, accounts).map((c) => c.target)
    const targets: ClaimTarget[] = []
    const parked: string[] = []
    for (let page = 0; page < CANDIDATE_PAGES && targets.length < limit; page++) {
        // Pages are a fixed size (not `limit`), so a small call budget still looks past waiting steps.
        const candidates = candidatePage(vendor, action, page * PAGE_SIZE, PAGE_SIZE, accounts)
        if (candidates.length === 0) break
        const { waiting, exhausted } = openPrerequisites(vendor, prerequisite, [...new Set(candidates.map((c) => c.task))])
        parked.push(...candidates.filter((c) => exhausted.has(c.task)).map((c) => c.target.stepId))
        targets.push(...readyTargets(candidates, waiting, limit - targets.length).map((c) => c.target))
        if (candidates.length < PAGE_SIZE) break
    }
    // Parked only after every page is read: parking moves steps out of the due query, which would shift later pages.
    park(parked)
    return targets
}

/** Of `tasks`, those with an open `prerequisite` step, and those whose open prerequisite step is exhausted. */
function openPrerequisites(vendor: OemVendor, prerequisite: ClaimAction, tasks: readonly string[]): { waiting: Set<string>; exhausted: Set<string> } {
    const step = new GlideRecord(STEP)
    step.addEncodedQuery(`${openStepsQuery(vendor, prerequisite)}^staging_taskIN${tasks.join(',')}`)
    step.query()
    const waiting = new Set<string>()
    const exhausted = new Set<string>()
    while (step.next()) {
        const task = str(step, 'staging_task')
        waiting.add(task)
        if (isExhausted({ status: str(step, 'automation_status'), attempts: num(step, 'attempts') })) exhausted.add(task)
    }
    return { waiting, exhausted }
}

/**
 * A step waiting on an exhausted prerequisite step would wait forever and sort first: park it as failed
 * for a person too (attempts at the maximum), so it leaves the due steps until releaseParkedSteps.
 */
function park(stepIds: readonly string[]): void {
    if (stepIds.length === 0) return
    const step = new GlideRecord(STEP)
    step.addQuery('sys_id', 'IN', stepIds.join(','))
    step.setValue('automation_status', 'failed')
    step.setValue('attempts', MAX_CLAIM_ATTEMPTS)
    step.setValue('automation_message', PARKED_MESSAGE)
    step.updateMultiple()
}

/** A `prerequisite` step on staging task `taskId` is done: the steps parked behind it are due again. */
export function releaseParkedSteps(taskId: string, prerequisite: string): void {
    const dependents = dependentActions(prerequisite)
    if (!taskId || dependents.length === 0) return
    // Per record: updateMultiple does not reliably clear a field to empty.
    const step = new GlideRecord(STEP)
    step.addQuery('staging_task', taskId)
    step.addQuery('automation', 'IN', dependents.join(','))
    step.addQuery('done', false)
    step.addQuery('automation_message', PARKED_MESSAGE)
    step.query()
    while (step.next()) {
        step.setValue('automation_status', 'pending')
        step.setValue('attempts', 0)
        step.setValue('automation_message', '')
        step.update()
    }
}

function candidatePage(vendor: OemVendor, action: ClaimAction, from: number, size: number, accounts: (key: string) => string): Array<{ task: string; target: ClaimTarget }> {
    const step = new GlideRecord(STEP)
    step.addEncodedQuery(dueStepsQuery(vendor, action))
    step.orderBy('attempts')
    step.orderBy('sys_created_on')
    step.orderBy('sys_id')
    step.chooseWindow(from, from + size, false)
    step.query()
    const candidates: Array<{ task: string; target: ClaimTarget }> = []
    while (step.next()) {
        const customerId = str(step, 'staging_task.asset.company')
        candidates.push({
            task: str(step, 'staging_task'),
            target: {
                stepId: step.getUniqueValue(),
                serial: str(step, 'staging_task.asset.serial_number'),
                mac: str(step, 'staging_task.asset.x_daas_ham_mac_address'),
                claimCode: str(step, 'staging_task.asset.x_daas_ham_claim_code'),
                account: accounts(`${customerId}|${vendor}|${action}`),
            },
        })
    }
    return candidates
}

/** The Customer's OEM cloud account for `action`, looked up once per customer and action. */
function cloudAccount(key: string): string {
    const [customerId, vendor, action] = key.split('|')
    const account = new GlideRecord('x_daas_ham_cloud_account')
    account.addQuery('customer', customerId)
    account.addQuery('vendor', vendor)
    account.addQuery('purpose', action)
    account.setLimit(1)
    account.query()
    return account.next() ? str(account, 'account_id') : ''
}

/** Tick the staging step, or count the failed attempt (it is left for a person after the last one). */
function settle(outcome: ClaimOutcome): void {
    const step = findById(STEP, outcome.stepId)
    if (!step) return
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
