import { GlideRecord, gs } from '@servicenow/glide'
import {
    CLAIM_PREREQUISITE,
    dependentActions,
    dueStepsQuery,
    type ClaimAction,
    type ClaimOutcome,
    type ClaimStore,
    type ClaimTarget,
} from '../domain/oem/claims.ts'
import type { OemVendor } from '../domain/oem/types.ts'
import { bool, num, pluck, recordsById, refusal, str } from './records.ts'
import { memoized } from '../domain/memo.ts'

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

/** Automated staging steps (x_daas_ham_staging_step) behind the claim run's ClaimStore port; caches OEM cloud accounts per run. */
export function glideClaimStore(): ClaimStore {
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
    step.addQuery('automation_status', 'waiting')
    step.query()
    while (step.next()) release(step)
}

/** Waiting steps a claim run checks for a prerequisite no longer open, at most: the longest waiting first. */
const STRANDED_LOAD = 200

/**
 * Release the waiting steps whose staging task (still active) has no open step of their prerequisite action
 * (CLAIM_PREREQUISITE) left to wait on: its release was refused when it was ticked done (logged), or it is gone. A
 * waiting step is never due, so left waiting it would never be sent. Run by each claim run, before it loads due steps.
 */
export function releaseStranded(): void {
    const waiting = new GlideRecord(STEP)
    waiting.addEncodedQuery('automation_status=waiting^done=false^staging_task.active=true')
    waiting.orderBy('sys_updated_on')
    waiting.setLimit(STRANDED_LOAD)
    waiting.query()
    const steps: Array<{ stepId: string; taskId: string; prerequisite: string }> = []
    while (waiting.next()) {
        const prerequisite = CLAIM_PREREQUISITE[str(waiting, 'automation') as ClaimAction] ?? ''
        steps.push({ stepId: waiting.getUniqueValue(), taskId: str(waiting, 'staging_task'), prerequisite })
    }
    if (steps.length === 0) return
    const open = new Set<string>()
    const openStep = new GlideRecord(STEP)
    openStep.addQuery('staging_task', 'IN', [...new Set(steps.map((s) => s.taskId))].join(','))
    openStep.addQuery('automation', 'IN', [...new Set(Object.values(CLAIM_PREREQUISITE))].join(','))
    openStep.addQuery('done', false)
    openStep.query()
    while (openStep.next()) open.add(`${str(openStep, 'staging_task')}|${str(openStep, 'automation')}`)
    const stranded = steps.filter((s) => !open.has(`${s.taskId}|${s.prerequisite}`)).map((s) => s.stepId)
    if (stranded.length === 0) return
    const step = new GlideRecord(STEP)
    step.addQuery('sys_id', 'IN', stranded.join(','))
    step.query()
    while (step.next()) release(step)
}

/**
 * A waiting step goes to pending, due to the next run. Saved one at a time, so a refused save is logged: left waiting,
 * the step is never sent, until a claim run releases it again (`releaseStranded`). The staging step rules run on the
 * save and react only to done changing.
 */
function release(step: GlideRecord): void {
    step.setValue('automation_status', 'pending')
    if (step.update()) return
    gs.warn(`[x_daas_ham] OEM step "${str(step, 'label')}" of ${step.getDisplayValue('staging_task')} still waiting, not released: ${refusal(step)}`)
}

/** The Customer's OEM cloud account for `action`, looked up once per customer and action. */
function cloudAccount(key: string): string {
    const [customerId, vendor, action] = key.split('|')
    return pluck('x_daas_ham_cloud_account', `customer=${customerId}^vendor=${vendor}^purpose=${action}`, 'account_id', 1)[0] ?? ''
}

/**
 * Tick each step of a run done, or count its failed attempt (it is left for a person after the last one); one query
 * for the run. A step found done already (ticked by hand meanwhile, or by a run that took over the claim run's lock) is
 * not marked failed. A step the platform refuses stays due, so the next run sends it again: that is logged, as nothing
 * else would say why a claim repeats or a failing step is never left for a person.
 */
function settle(outcomes: readonly ClaimOutcome[]): void {
    if (outcomes.length === 0) return
    const byStep = new Map<string, ClaimOutcome>(outcomes.map((outcome) => [outcome.stepId, outcome]))
    const step = new GlideRecord(STEP)
    step.addQuery('sys_id', 'IN', [...byStep.keys()].join(','))
    step.query()
    while (step.next()) {
        const outcome = byStep.get(step.getUniqueValue())
        if (!outcome || (!outcome.ok && bool(step, 'done'))) continue
        step.setValue('automation_message', outcome.message)
        if (outcome.ok) {
            step.setValue('automation_status', 'done')
            step.setValue('done', true)
        } else {
            step.setValue('automation_status', 'failed')
            step.setValue('attempts', num(step, 'attempts') + 1)
        }
        if (step.update()) continue
        const reason = refusal(step)
        const which = `"${str(step, 'label')}" of ${step.getDisplayValue('staging_task')}`
        gs.warn(`[x_daas_ham] OEM claim step ${which} not saved as ${outcome.ok ? 'done' : 'failed'}: ${reason}`)
    }
}
