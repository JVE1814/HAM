import { GlideRecord } from '@servicenow/glide'
import { dueStepsQuery, type ClaimAction, type ClaimOutcome, type ClaimStore, type ClaimTarget } from '../domain/oem/claims'
import type { OemVendor } from '../domain/oem/types'
import { findById, num, str } from './records'

/** Automated staging steps (x_daas_ham_staging_step) behind the claim run's ClaimStore port; caches OEM cloud accounts per run. */
export function glideClaimStore(): ClaimStore {
    const accounts = new Map<string, string>()
    return {
        due: (vendor, action, limit) => dueTargets(vendor, action, limit, accounts),
        settle,
    }
}

function dueTargets(vendor: OemVendor, action: ClaimAction, limit: number, accounts: Map<string, string>): ClaimTarget[] {
    const step = new GlideRecord('x_daas_ham_staging_step')
    step.addEncodedQuery(dueStepsQuery(vendor, action))
    step.orderBy('attempts')
    step.orderBy('sys_created_on')
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
            account: cloudAccount(customerId, vendor, action, accounts),
        })
    }
    return targets
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
