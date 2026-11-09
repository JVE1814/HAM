import { GlideRecord, gs } from '@servicenow/glide'
import {
    disposalApprovers,
    disposalCustomerFindings,
    disposalLineBlockers,
    disposalScopeRefusal,
    disposalStage,
    type DisposalAsset,
} from '../domain/disposal.ts'
import type { Stage } from '../domain/lifecycle.ts'
import type { DisposalMethod, LegalOwner } from '../domain/vocabulary.ts'
import {
    customerAdminIds,
    providerApproverIds,
    putToApproval,
    rollUpApprovals,
    type ApprovalFlow,
    type ApprovalRollup,
} from './approvals.ts'
import { isFleetAsset, moveAsset, readStage, transitionFacts } from './assets.ts'
import { findById, refusal, str, warnRefused } from './records.ts'

/**
 * Disposal orders: approve, then retire each wiped Asset by its method (P2.5, D61). None of it tells the user anything:
 * each gives what came of it, for the form button or rule that asked.
 */

/** The task states a Disposal order closes with: Closed Complete once every line is retired, Closed Incomplete when rejected. */
const DISPOSAL_TASK_STATE = { complete: 3, rejected: 4 } as const

/** Line fields that say what is retired and how; the rest (status, blockers, amounts) stays writable after submit. */
const LINE_SCOPE = ['disposal_order', 'asset', 'method']

function lines(orderId: string): GlideRecord {
    const line = new GlideRecord('x_daas_ham_disposal_line')
    line.addQuery('disposal_order', orderId)
    line.query()
    return line
}

function assetsOf(orderId: string): DisposalAsset[] {
    const assets: DisposalAsset[] = []
    const line = lines(orderId)
    while (line.next()) {
        assets.push({
            legalOwner: str(line, 'asset.x_daas_ham_legal_owner') as LegalOwner | '',
            customerId: str(line, 'asset.company'),
            label: str(line, 'asset.serial_number') || line.getDisplayValue('asset'),
        })
    }
    return assets
}

function ownersOf(orderId: string): Array<LegalOwner | ''> {
    return assetsOf(orderId).map((asset) => asset.legalOwner)
}

/**
 * What came of submitting a draft Disposal order: it awaits its approvers, or it stays a draft and why. `why` is ''
 * when the platform has told the user already: it refused the save of the form the order was submitted from.
 */
export type DisposalSubmission = { submitted: true } | { submitted: false; why: string }

/**
 * Put a draft Disposal order to approval (platform/approvals `putToApproval`): the provider-side approvers (the asset
 * managers), and the admins of the order's Customer when a customer-owned Asset is on it. Nobody stands in for a
 * Customer without admins: the order then stays a draft.
 */
export function submitDisposal(order: GlideRecord): DisposalSubmission {
    const assets = assetsOf(order.getUniqueValue())
    if (assets.length === 0) return { submitted: false, why: 'Add the assets to dispose of first' }
    const findings = disposalCustomerFindings(str(order, 'customer'), assets)
    if (findings.length > 0) return { submitted: false, why: findings.join('. ') }
    const required = disposalApprovers(assets.map((asset) => asset.legalOwner))
    const customerAdmins = customerAdminIds(str(order, 'customer'))
    const approvers = new Set<string>()
    for (const group of required) {
        for (const id of group === 'customer_admin' ? customerAdmins : providerApproverIds('')) approvers.add(id)
    }
    const asked = putToApproval(order, {
        approverIds: [...approvers],
        required,
        customerAdmins,
        noApprover: 'no asset manager to approve it',
    })
    if (asked.awaiting) return { submitted: true }
    return { submitted: false, why: asked.step === 'request' ? `Not submitted: ${asked.reason}` : '' }
}

/** How a Disposal order's approvals are decided (platform/approvals): by its Assets' owners, approved or rejected and closed. */
const DISPOSAL_APPROVAL: ApprovalFlow = {
    required: (order) => disposalApprovers(ownersOf(order.getUniqueValue())),
    decide: (order, outcome) => {
        order.setValue('approval', outcome)
        order.setValue('stage', outcome === 'approved' ? 'approved' : 'rejected')
        if (outcome === 'rejected') order.setValue('state', DISPOSAL_TASK_STATE.rejected)
        // Refused: it still awaits approval with its requests open, so the next decision on them rolls it up again.
        return order.update() ? '' : warnRefused(order, `Disposal ${str(order, 'number')} not saved as ${outcome}`)
    },
}

/**
 * Roll the approvals of the Disposal order up and save the outcome (platform/approvals `rollUpApprovals`): what a
 * decision on one of its requests does. Null when the order is gone or not awaiting approval.
 */
export function rollUpDisposalApprovals(orderId: string): ApprovalRollup | null {
    const order = findById('x_daas_ham_disposal_order', orderId)
    return order ? rollUpApprovals(order, DISPOSAL_APPROVAL) : null
}

/**
 * What came of completing a Disposal order: how many lines stay blocked and how many could not be saved (logged); it
 * is `completed` when there are none of either and the order was saved as completed.
 */
export interface DisposalCompletion {
    completed: boolean
    blocked: number
    unsaved: number
}

/** Retire every ready line of the Disposal order and record what blocks the rest; the order completes once none is left. */
export function completeDisposal(order: GlideRecord): DisposalCompletion {
    let blocked = 0
    let unsaved = 0
    const line = lines(order.getUniqueValue())
    while (line.next()) {
        if (str(line, 'status') === 'done') continue
        const blockers = retire(line, order)
        if (blockers) blocked++
        line.setValue('status', blockers ? 'blocked' : 'done')
        line.setValue('blockers', blockers)
        if (line.update()) continue
        // A line not saved as done keeps the order open: its Asset may be retired already, so it is set done by hand.
        unsaved++
        const reason = refusal(line)
        const what = `${str(order, 'number')} line for ${line.getDisplayValue('asset')}`
        gs.warn(`[x_daas_ham] ${what} not saved (${blockers ? 'blocked' : 'done, its asset retired'}): ${reason}`)
    }
    if (blocked > 0 || unsaved > 0) return { completed: false, blocked, unsaved }
    order.setValue('stage', 'completed')
    order.setValue('state', DISPOSAL_TASK_STATE.complete)
    // Refused, it stays approved with every line done: completing it again saves only the order.
    return { completed: !!order.update(), blocked, unsaved }
}

/**
 * Retire a line's Asset by its method; why it was not (empty when it was). An Asset the user cannot read (outside
 * their Stockrooms, ADR 0005) blocks its line rather than being skipped. The lifecycle rule checks each saved move,
 * so a pending-wipe Asset is saved as pending disposal first, and the line is done only once the retiring save holds.
 */
function retire(line: GlideRecord, order: GlideRecord): string {
    const asset = findById('alm_hardware', str(line, 'asset'))
    if (!asset) return 'asset not found, or not in your stockrooms'
    const method = (str(line, 'method') || str(order, 'method')) as DisposalMethod
    const facts = transitionFacts(asset)
    const stage = readStage(asset)
    const blockers = disposalLineBlockers({
        fleet: isFleetAsset(asset),
        legalOwner: facts.legalOwner,
        method,
        wipeComplete: facts.wipeEvidenceComplete,
        stage,
        customerId: str(asset, 'company'),
        orderCustomerId: str(order, 'customer'),
    })
    if (blockers.length > 0) return blockers.join('; ')
    if (stage === 'pending_wipe') {
        const refusal = moveAndKeep(asset, 'pending_disposal')
        if (refusal) return refusal
    }
    return moveAndKeep(asset, disposalStage(method))
}

/**
 * Move the Asset and save it; why that was refused (empty once saved). Unlike platform/assets `moveAndSave`, a refusal
 * is not logged: it goes on the line as what blocks it.
 */
function moveAndKeep(asset: GlideRecord, to: Stage): string {
    const verdict = moveAsset(asset, to)
    if (!verdict.allowed) return verdict.reason
    return asset.update() ? '' : refusal(asset, `the asset could not be saved as ${to}`)
}

/**
 * Why this insert, update or delete of a Disposal line is refused ('' when it is not): once the order leaves draft no
 * line is added, removed or pointed at another order, Asset or method, so what is retired is what was approved. An
 * update moving a line checks the order it leaves too.
 */
export function lineChangeRefusal(current: GlideRecord, previous: GlideRecord): string {
    const operation = current.operation()
    if (operation === 'update' && LINE_SCOPE.every((field) => str(current, field) === str(previous, field))) return ''
    const stages = [str(current, 'disposal_order.stage')]
    if (operation === 'update') stages.push(str(previous, 'disposal_order.stage'))
    return disposalScopeRefusal(stages)
}

/** Why a change of a Disposal order's method or Customer is refused ('' when it is not): both are fixed at submit, like the lines. */
export function orderChangeRefusal(previous: GlideRecord): string {
    return disposalScopeRefusal([str(previous, 'stage')])
}

/**
 * A draft return-to-lessor Disposal order for the stock of a lease being returned (platform/leases); null when the
 * platform refuses it (logged).
 */
export function draftLessorDisposal(lease: GlideRecord): GlideRecord | null {
    const order = new GlideRecord('x_daas_ham_disposal_order')
    order.initialize()
    order.setValue('method', 'return_to_lessor')
    order.setValue('disposal_vendor', str(lease, 'vendor'))
    order.setValue('short_description', `Return stock to the lessor at the end of lease ${str(lease, 'number')}`)
    if (order.insert()) return order
    warnRefused(order, `Lease return: no disposal order for ${str(lease, 'number')}`)
    return null
}

/** Put a returned lease's Asset on its draft Disposal order; false (logged) when the platform refuses the line. */
export function addDisposalLine(order: GlideRecord, asset: GlideRecord): boolean {
    const line = new GlideRecord('x_daas_ham_disposal_line')
    line.initialize()
    line.setValue('disposal_order', order.getUniqueValue())
    line.setValue('asset', asset.getUniqueValue())
    if (line.insert()) return true
    warnRefused(line, `Lease return: ${str(asset, 'serial_number')} left off ${str(order, 'number')}`)
    return false
}
