import { GlideRecord } from '@servicenow/glide'
import {
    CLAIM_VENDORS,
    dependentActions,
    dueStepsQuery,
    runVendorClaims,
    settledStatus,
    STEP_STATUS,
    type ClaimOutcome,
    type ClaimStore,
    type ClaimTarget,
} from '../domain/oem/claims.ts'
import { boolProperty, intProperty, PROPERTY, type PropertyOf } from './properties.ts'
import { restMessagePort } from './rest-messages.ts'
import { num, pluck, recordsById, str, warnRefused } from './records.ts'
import { memoized } from '../domain/memo.ts'
import type { ClaimAction, OemVendor } from '../domain/vocabulary.ts'

const STEP = 'x_daas_ham_staging_step'

/** The fields of a step's Asset that a claim needs. */
interface ClaimAsset {
    customerId: string
    serial: string
    mac: string
    claimCode: string
}

/** A staging task or Asset not found reads as empty, as a dot-walk through a broken reference did. */
const NO_ASSET: ClaimAsset = { customerId: '', serial: '', mac: '', claimCode: '' }

/** The property that turns each vendor's claims on: a vendor without one is never claimed for. */
const CLAIM_ENABLED: Partial<Record<OemVendor, PropertyOf<boolean>>> = PROPERTY.claimEnabled

/**
 * For each enabled vendor, send its due automated staging steps (pending, and failed ones due a retry) through the
 * vendor's adapters, within `x_daas_ham.oem.claim.max_calls` calls a vendor (domain/oem/claims `runVendorClaims`).
 */
export function runClaims(): void {
    const maxCalls = intProperty(PROPERTY.claimMaxCalls)
    const store = glideClaimStore()
    for (const vendor of CLAIM_VENDORS) {
        const enabled = CLAIM_ENABLED[vendor]
        if (enabled && boolProperty(enabled)) runVendorClaims(vendor, store, restMessagePort, maxCalls)
    }
}

/** Automated staging steps (x_daas_ham_staging_step) behind the claim run's ClaimStore port; caches OEM cloud accounts per run. */
function glideClaimStore(): ClaimStore {
    const accounts = memoized(cloudAccount)
    return {
        due: (vendor, action, limit) => dueTargets(vendor, action, limit, accounts),
        settle,
    }
}

/** Up to `limit` due steps (dueStepsQuery), fewest attempts first, then oldest; their staging tasks and Assets are read with one query each. */
function dueTargets(vendor: OemVendor, action: ClaimAction, limit: number, accounts: (key: string) => string): ClaimTarget[] {
    const step = new GlideRecord(STEP)
    step.addEncodedQuery(dueStepsQuery(vendor, action))
    step.orderBy('attempts')
    step.orderBy('sys_created_on')
    step.orderBy('sys_id')
    step.setLimit(limit)
    step.query()
    const steps: Array<{ stepId: string; taskId: string }> = []
    while (step.next()) steps.push({ stepId: step.getUniqueValue(), taskId: str(step, 'staging_task') })
    const assetOfTask = recordsById('x_daas_ham_staging_task', steps.map((s) => s.taskId), (task) => str(task, 'asset'))
    const assets = recordsById(
        'alm_hardware',
        assetOfTask.values(),
        (asset): ClaimAsset => ({
            customerId: str(asset, 'company'),
            serial: str(asset, 'serial_number'),
            mac: str(asset, 'x_daas_ham_mac_address'),
            claimCode: str(asset, 'x_daas_ham_claim_code'),
        }),
    )
    return steps.map(({ stepId, taskId }) => {
        const { customerId, serial, mac, claimCode } = assets.get(assetOfTask.get(taskId) ?? '') ?? NO_ASSET
        return { stepId, serial, mac, claimCode, account: accounts(`${customerId}|${vendor}|${action}`) }
    })
}

/** A step of `action` on staging task `taskId` was ticked done: release the task's open steps waiting on it (initialAutomationStatus). */
export function releaseStepsWaitingOn(taskId: string, action: string): void {
    const dependents = dependentActions(action)
    if (!taskId || dependents.length === 0) return
    const step = new GlideRecord(STEP)
    step.addQuery('staging_task', taskId)
    step.addQuery('automation', 'IN', dependents.join(','))
    step.addQuery('done', false)
    step.addQuery('automation_status', STEP_STATUS.waiting)
    // One set-based update: the staging step rules still run, and they react only to done changing.
    step.setValue('automation_status', STEP_STATUS.due)
    step.updateMultiple()
}

/** The Customer's OEM cloud account for `action`, looked up once per customer and action. */
function cloudAccount(key: string): string {
    const [customerId, vendor, action] = key.split('|')
    return pluck('x_daas_ham_cloud_account', `customer=${customerId}^vendor=${vendor}^purpose=${action}`, 'account_id', 1)[0] ?? ''
}

/**
 * Tick each step of a run done, or count its failed attempt (it is left for a person after the last one); one query
 * for the run. A step the platform refuses stays due, so the next run sends it again: that is logged, as nothing else
 * would say why a claim repeats or a failing step is never left for a person.
 */
function settle(outcomes: readonly ClaimOutcome[]): void {
    if (outcomes.length === 0) return
    const byStep = new Map<string, ClaimOutcome>(outcomes.map((outcome) => [outcome.stepId, outcome]))
    const step = new GlideRecord(STEP)
    step.addQuery('sys_id', 'IN', [...byStep.keys()].join(','))
    step.query()
    while (step.next()) {
        const outcome = byStep.get(step.getUniqueValue())
        if (!outcome) continue
        const status = settledStatus(outcome)
        step.setValue('automation_message', outcome.message)
        step.setValue('automation_status', status)
        if (outcome.ok) step.setValue('done', true)
        else step.setValue('attempts', num(step, 'attempts') + 1)
        if (step.update()) continue
        warnRefused(step, `OEM claim step "${str(step, 'label')}" of ${step.getDisplayValue('staging_task')} not saved as ${status}`)
    }
}
