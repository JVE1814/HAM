// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideRecord } from '@servicenow/glide'
import { CLAIM_ROUTES, MAX_CLAIM_ATTEMPTS, type ClaimAction, type ClaimOutcome, type ClaimTarget } from '../domain/oem/claims'
import type { OemVendor } from '../domain/oem/types'
import { restMessagePort } from '../platform/rest-port'
import { boolProperty, intProperty, PROPERTY } from '../platform/properties'
import { findById, num, str } from '../platform/records'

/** OEM claim and provisioning: staging steps the manufacturer's cloud does (P3.27, D70). */

const BATCH = 200

/**
 * Every 5 minutes: for each enabled vendor, send its pending (and stale failed) automated staging
 * steps through the vendor's adapters within `x_daas_ham.oem.claim.max_calls` calls per run.
 */
export function runOemClaims(): void {
    const maxCalls = intProperty(PROPERTY.claimMaxCalls, 8)
    for (const [vendor, routes] of Object.entries(CLAIM_ROUTES) as Array<[OemVendor, NonNullable<(typeof CLAIM_ROUTES)[OemVendor]>]>) {
        if (!boolProperty(`x_daas_ham.oem.claim.${vendor}.enabled`, false)) continue
        let budget = maxCalls
        const accounts = new Map<string, string>()
        for (const [action, route] of Object.entries(routes) as Array<[ClaimAction, NonNullable<(typeof routes)[ClaimAction]>]>) {
            if (budget <= 0) break
            const targets = pendingTargets(vendor, action, accounts)
            if (targets.length === 0) continue
            const run = route.run(targets, restMessagePort(route.message), budget)
            budget -= run.calls
            for (const outcome of run.outcomes) settle(outcome)
        }
    }
}

function pendingTargets(vendor: OemVendor, action: ClaimAction, accounts: Map<string, string>): ClaimTarget[] {
    const base = `automation=${action}^done=false^staging_task.active=true^staging_task.asset.model.x_daas_ham_oem_source=${vendor}`
    const step = new GlideRecord('x_daas_ham_staging_step')
    // Pending steps, plus failed ones last tried over 30 minutes ago that have attempts left.
    step.addEncodedQuery(
        `${base}^automation_status=pending^NQ${base}^automation_status=failed^attempts<${MAX_CLAIM_ATTEMPTS}^sys_updated_on<javascript:gs.minutesAgoStart(30)`,
    )
    step.orderBy('attempts')
    step.orderBy('sys_created_on')
    step.setLimit(BATCH)
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

function cloudAccount(customerId: string, vendor: OemVendor, action: ClaimAction, cache: Map<string, string>): string {
    const key = `${customerId}|${action}`
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
    step.setValue('automation_message', outcome.message.slice(0, 255))
    if (outcome.ok) {
        step.setValue('automation_status', 'done')
        step.setValue('done', true)
    } else {
        step.setValue('automation_status', 'failed')
        step.setValue('attempts', num(step, 'attempts') + 1)
    }
    step.update()
}
