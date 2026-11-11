import { GlideRecord } from '@servicenow/glide'
import type { HeldLock } from '../domain/job-lock.ts'
import { LOCK } from '../domain/lock-names.ts'
import { CLAIM_VENDORS, OEM_ADAPTERS } from '../domain/oem/adapters.ts'
import {
    CLAIM_PREREQUISITE,
    dependentActions,
    dueStepsQuery,
    runVendorClaims,
    settledStatus,
    STEP_STATUS,
    type ClaimOutcome,
    type ClaimStore,
    type ClaimTarget,
} from '../domain/oem/claims.ts'
import { openJobCursor, type JobCursor } from './job-cursor.ts'
import { withLock } from './locks.ts'
import { boolProperty, intProperty } from './properties.ts'
import { PROPERTY } from '../domain/properties.ts'
import { restMessagePort } from './rest-messages.ts'
import { bool, num, pluck, recordsById, str, warnRefused } from './records.ts'
import { messageOf } from '../domain/errors.ts'
import { memoized } from '../domain/memo.ts'
import type { ClaimAction, OemVendor } from '../domain/vocabulary.ts'
import { log } from './log.ts'

/**
 * The automated steps of a Staging task (x_daas_ham_staging_step rows with an `automation`) and the OEM claims they
 * stand for. Of a step's state (domain/oem/claims `STEP_STATUS`), this module owns what follows its creation: a step
 * waiting on another is released once that one is ticked (`releaseStepsWaitingOn`: waiting to due), or by the next
 * claim run when that release was refused (`releaseStranded`), and the claim run settles each step it sent (`settle`:
 * done and ticked, or failed with one more attempt and the vendor's message).
 * The rest is platform/staging-tasks': it creates a task's steps, each automated one in its
 * `initialAutomationStatus`, and removes them with a task that could not be opened. A person ticks the steps done by
 * hand; who and when is stamped by the before rule (entry/staging `stampStagingStep`).
 */

const STEP = 'x_daas_ham_staging_step'

interface ClaimAsset {
    customerId: string
    serial: string
    mac: string
    claimCode: string
}

const NO_ASSET: ClaimAsset = { customerId: '', serial: '', mac: '', claimCode: '' }

/**
 * For each enabled vendor, send its due automated staging steps (pending, and failed ones due a retry) through the
 * vendor's adapters, within `x_daas_ham.oem.claim.max_calls` calls a vendor (domain/oem/claims `runVendorClaims`),
 * holding the run's lock (domain/lock-names `oemClaimRun`, ADR 0013). Two runs at once (the 5-minute job and an *Execute
 * now*) would load the same due steps and send each to its vendor twice, spending two runs' calls in one rate-limit
 * window (Meraki allows 10 calls in 5 minutes), and the second claim of a device already claimed fails, marking a step
 * the first run ticked done failed again. A run that finds the lock held sends nothing and leaves the steps to the run
 * holding it. A run that outlasts the lock sends nothing more once it has lost it, checked before every call
 * (runVendorClaims): it saves what its calls so far returned, leaves the steps it did not send to the run that took the
 * lock over, and that run goes on.
 */
export function runClaims(): void {
    const lockName = LOCK.oemClaimRun()
    if (withLock(lockName, runHolding).ran) return
    log.info(`OEM claims not sent: another run holds the ${lockName} lock and sends them`)
}

function runHolding(lock: HeldLock): void {
    const maxCalls = intProperty(PROPERTY.claimMaxCalls)
    releaseStranded()
    const store = glideClaimStore()
    for (const vendor of CLAIM_VENDORS) {
        const claims = OEM_ADAPTERS[vendor].claims
        if (!claims || !boolProperty(claims.enabled)) continue
        if (runVendorClaims(vendor, claims.routes, store, restMessagePort, maxCalls, () => lock.held()).lockLost) {
            log.warn(`OEM claim run stopped: job lock lost while sending, to the run that took it over`)
            return
        }
    }
}

function glideClaimStore(): ClaimStore {
    const accounts = memoized(cloudAccount)
    return {
        due: (vendor, action, limit) => dueTargets(vendor, action, limit, accounts),
        settle,
    }
}

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

export function releaseStepsWaitingOn(taskId: string, action: string): void {
    const dependents = dependentActions(action)
    if (!taskId || dependents.length === 0) return
    const step = new GlideRecord(STEP)
    step.addQuery('staging_task', taskId)
    step.addQuery('automation', 'IN', dependents.join(','))
    step.addQuery('done', false)
    step.addQuery('automation_status', STEP_STATUS.waiting)
    step.query()
    while (step.next()) release(step)
}

/** Waiting steps a claim run checks for a prerequisite no longer open, at most. */
const STRANDED_LOAD = 200

const STRANDED_CURSOR = 'oem_claim_stranded'

/**
 * Release the waiting steps whose staging task (still active) has no open step of their prerequisite action
 * (CLAIM_PREREQUISITE) left to wait on: its release was refused when it was ticked done (logged), or it is gone. A
 * waiting step is never due, so left waiting it would never be sent. Run by each claim run, before it loads due steps,
 * holding its run lock. A run checks the next STRANDED_LOAD in sys_id order after the last one the run before checked,
 * starting over after the last: steps still rightly waiting never keep a stranded one from its turn.
 */
function releaseStranded(): void {
    const cursor = strandedCursor()
    const after = cursor?.cursor ?? ''
    let steps = waitingSteps(after)
    if (steps.length === 0 && after) steps = waitingSteps('')
    if (cursor) saveStrandedCursor(cursor, steps.length === STRANDED_LOAD ? (steps[steps.length - 1]?.stepId ?? '') : '')
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

function waitingSteps(after: string): Array<{ stepId: string; taskId: string; prerequisite: string }> {
    const waiting = new GlideRecord(STEP)
    waiting.addEncodedQuery(`automation_status=${STEP_STATUS.waiting}^done=false^staging_task.active=true`)
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

function strandedCursor(): JobCursor | null {
    try {
        return openJobCursor(STRANDED_CURSOR)
    } catch (error) {
        log.warn(`Job cursor ${STRANDED_CURSOR} not created, so each claim run checks the same waiting steps: ${messageOf(error)}`)
        return null
    }
}

function saveStrandedCursor(cursor: JobCursor, next: string): void {
    if (cursor.cursor === next) return
    const refused = cursor.save({ cursor: next })
    if (refused) log.warn(`Job cursor ${STRANDED_CURSOR} not saved, so the next claim run checks the same waiting steps: ${refused}`)
}

/**
 * A waiting step becomes due to the next run. Saved one at a time, so a refused save is logged: left waiting, the step
 * is never sent, until a claim run releases it again (`releaseStranded`). The staging step rules run on the save and
 * react only to done changing.
 */
function release(step: GlideRecord): void {
    step.setValue('automation_status', STEP_STATUS.due)
    if (!step.update()) warnRefused(step, `OEM step "${str(step, 'label')}" of ${step.getDisplayValue('staging_task')} still waiting, not released`)
}

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
        const status = settledStatus(outcome)
        step.setValue('automation_message', outcome.message)
        step.setValue('automation_status', status)
        if (outcome.ok) step.setValue('done', true)
        else step.setValue('attempts', num(step, 'attempts') + 1)
        if (step.update()) continue
        warnRefused(step, `OEM claim step "${str(step, 'label')}" of ${step.getDisplayValue('staging_task')} not saved as ${status}`)
    }
}
