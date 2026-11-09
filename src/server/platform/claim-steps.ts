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

/** Waiting steps a claim run checks for a prerequisite no longer open, at most. */
const STRANDED_LOAD = 200

/** The job cursor row (x_daas_ham_job_cursor) holding the sys_id of the last waiting step a claim run checked. */
const STRANDED_CURSOR = 'oem_claim_stranded'

/**
 * Release the waiting steps whose staging task (still active) has no open step of their prerequisite action
 * (CLAIM_PREREQUISITE) left to wait on: its release was refused when it was ticked done (logged), or it is gone. A
 * waiting step is never due, so left waiting it would never be sent. Run by each claim run, before it loads due steps,
 * holding its run lock. A run checks the next STRANDED_LOAD in sys_id order after the last one the run before checked,
 * starting over after the last: steps still rightly waiting never keep a stranded one from its turn.
 */
export function releaseStranded(): void {
    const cursor = strandedCursor()
    const after = cursor ? str(cursor, 'cursor') : ''
    let steps = waitingSteps(after)
    // None left after the cursor: the pass is over, and this run starts the next.
    if (steps.length === 0 && after) steps = waitingSteps('')
    // A short page ends the pass, so the next run starts from the first step.
    if (cursor) saveStrandedCursor(cursor, steps.length === STRANDED_LOAD ? steps[steps.length - 1].stepId : '')
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

/** Up to STRANDED_LOAD waiting steps of active staging tasks, in sys_id order after `after` ('' for the first). */
function waitingSteps(after: string): Array<{ stepId: string; taskId: string; prerequisite: string }> {
    const waiting = new GlideRecord(STEP)
    waiting.addEncodedQuery('automation_status=waiting^done=false^staging_task.active=true')
    if (after) waiting.addQuery('sys_id', '>', after)
    waiting.orderBy('sys_id')
    waiting.setLimit(STRANDED_LOAD)
    waiting.query()
    const steps: Array<{ stepId: string; taskId: string; prerequisite: string }> = []
    while (waiting.next()) {
        const prerequisite = CLAIM_PREREQUISITE[str(waiting, 'automation') as ClaimAction] ?? ''
        steps.push({ stepId: waiting.getUniqueValue(), taskId: str(waiting, 'staging_task'), prerequisite })
    }
    return steps
}

/**
 * The stranded-step cursor row, created on the first run; null (logged) when it cannot be: each run then checks the
 * first STRANDED_LOAD waiting steps only.
 */
function strandedCursor(): GlideRecord | null {
    const row = new GlideRecord('x_daas_ham_job_cursor')
    if (row.get('job', STRANDED_CURSOR)) return row
    row.initialize()
    row.setValue('job', STRANDED_CURSOR)
    row.setValue('cursor', '')
    if (row.insert()) return row
    // A run that outlasted its lock may have created it first (the unique index on job).
    const created = new GlideRecord('x_daas_ham_job_cursor')
    if (created.get('job', STRANDED_CURSOR)) return created
    gs.warn(`[x_daas_ham] Job cursor ${STRANDED_CURSOR} not created, so each claim run checks the same waiting steps: ${refusal(row)}`)
    return null
}

/** Save where the next run checks from; a refused save is logged, and the next run checks this run's steps again. */
function saveStrandedCursor(row: GlideRecord, next: string): void {
    if (str(row, 'cursor') === next) return
    row.setValue('cursor', next)
    if (row.update()) return
    gs.warn(`[x_daas_ham] Job cursor ${STRANDED_CURSOR} not saved, so the next claim run checks the same waiting steps: ${refusal(row)}`)
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
