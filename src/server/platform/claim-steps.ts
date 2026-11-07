import { GlideRecord } from '@servicenow/glide'
import { CLAIM_PREREQUISITE, dueStepsQuery, openStepsQuery, readyTargets, type ClaimAction, type ClaimOutcome, type ClaimStore, type ClaimTarget } from '../domain/oem/claims'
import type { OemVendor } from '../domain/oem/types'
import { findById, num, pluck, str } from './records'

/** Automated staging steps (x_daas_ham_staging_step) behind the claim run's ClaimStore port; caches OEM cloud accounts per run. */
export function glideClaimStore(): ClaimStore {
    const accounts = new Map<string, string>()
    return {
        due: (vendor, action, limit) => dueTargets(vendor, action, limit, accounts),
        settle,
    }
}

/** Candidate pages read past steps that wait on a prerequisite, so waiting steps cannot starve ready ones. */
const CANDIDATE_PAGES = 5

/**
 * Up to `limit` due steps. For an action with a prerequisite, each page of candidates is checked
 * against open prerequisite steps of the same tasks (one bounded query per page), and the limit counts
 * only ready steps; waiting steps are not loaded as targets, so they use no attempts.
 */
function dueTargets(vendor: OemVendor, action: ClaimAction, limit: number, accounts: Map<string, string>): ClaimTarget[] {
    const prerequisite = CLAIM_PREREQUISITE[action]
    const targets: ClaimTarget[] = []
    for (let page = 0; page < (prerequisite ? CANDIDATE_PAGES : 1) && targets.length < limit; page++) {
        const candidates = candidatePage(vendor, action, page * limit, limit, accounts)
        const tasks = [...new Set(candidates.map((c) => c.task))]
        const waiting = new Set(
            prerequisite && tasks.length > 0 ? pluck('x_daas_ham_staging_step', `${openStepsQuery(vendor, prerequisite)}^staging_taskIN${tasks.join(',')}`, 'staging_task') : [],
        )
        targets.push(...readyTargets(candidates, waiting, limit - targets.length).map((c) => c.target))
        if (candidates.length < limit) break
    }
    return targets
}

function candidatePage(vendor: OemVendor, action: ClaimAction, from: number, size: number, accounts: Map<string, string>): Array<{ task: string; target: ClaimTarget }> {
    const step = new GlideRecord('x_daas_ham_staging_step')
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
                account: cloudAccount(customerId, vendor, action, accounts),
            },
        })
    }
    return candidates
}

/** The Customer's OEM cloud account for `action`, looked up once per customer and action. */
function cloudAccount(customerId: string, vendor: OemVendor, action: ClaimAction, cache: Map<string, string>): string {
    const key = `${customerId}|${vendor}|${action}`
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const account = new GlideRecord('x_daas_ham_cloud_account')
    account.addQuery('customer', customerId)
    account.addQuery('vendor', vendor)
    account.addQuery('purpose', action)
    account.setLimit(1)
    account.query()
    const id = account.next() ? str(account, 'account_id') : ''
    cache.set(key, id)
    return id
}

/** Tick the staging step, or count the failed attempt (it is left for a person after the last one). */
function settle(outcome: ClaimOutcome): void {
    const step = findById('x_daas_ham_staging_step', outcome.stepId)
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
