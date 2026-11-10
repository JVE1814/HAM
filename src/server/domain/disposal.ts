import type { Approver } from './approvals.ts'
import { disposalMethodsFor, legalOwnerOf, type Stage } from './lifecycle.ts'
import type { DisposalMethod, LegalOwner } from './vocabulary.ts'

/** Disposal orders (P2.5, D61). */

/** A line's Asset as Complete disposal finds it; `customerId` is its company: the Customer it belongs to (ADR 0006). */
export interface DisposalLine {
    /** It is a fleet asset (ADR 0016): the app retires no equipment of the Provider IT's. */
    fleet: boolean
    legalOwner: LegalOwner | ''
    method: DisposalMethod
    wipeComplete: boolean
    stage: Stage | null
    customerId: string
    /** The order's Customer, whose admins approved returning customer-owned Assets. */
    orderCustomerId: string
}

/** Why a line cannot be completed yet (empty when it can). */
export function disposalLineBlockers(line: DisposalLine): string[] {
    const owner = legalOwnerOf(line.legalOwner)
    const methods = disposalMethodsFor(owner)
    const blockers: string[] = []
    if (!line.fleet) blockers.push('asset is not a fleet asset')
    if (line.stage !== 'pending_wipe' && line.stage !== 'pending_disposal') {
        blockers.push(`asset is ${line.stage ?? 'in an unmodelled stage'}, not awaiting wipe or disposal`)
    }
    if (!methods.includes(line.method)) {
        blockers.push(`a ${owner}-owned asset can only be ${methods.map((m) => m.replace(/_/g, ' ')).join(' or ')}`)
    }
    // An order with no Customer asked no Customer admins, so it returns no customer-owned Asset.
    if (owner === 'customer' && (!line.orderCustomerId || line.customerId !== line.orderCustomerId)) {
        blockers.push("asset does not belong to the order's customer")
    }
    if (!line.wipeComplete) blockers.push('no wipe evidence')
    return blockers
}

/** An Asset on a Disposal order at submit: its legal owner, the Customer it belongs to (its company), its name. */
export interface DisposalAsset {
    legalOwner: LegalOwner | ''
    customerId: string
    label: string
}

/**
 * Why the order's Customer cannot approve returning its customer-owned Assets (empty when it can): the owner's
 * admins are the ones asked, so every customer-owned Asset must belong to the order's Customer.
 */
export function disposalCustomerFindings(orderCustomerId: string, assets: readonly DisposalAsset[]): string[] {
    const owned = assets.filter((asset) => asset.legalOwner === 'customer')
    if (owned.length === 0) return []
    if (!orderCustomerId) return ['Set the customer whose assets are being returned']
    const others = owned.filter((asset) => asset.customerId !== orderCustomerId).map((asset) => asset.label)
    return others.length === 0 ? [] : [`Not the order's customer's assets: ${others.join(', ')}`]
}

/**
 * Why a change to what a Disposal order retires (adding, removing or re-pointing a line; the order's method or
 * Customer) is refused; empty when it is not. That is fixed once the order leaves draft, so what is retired is
 * what was approved; Complete disposal still records each line's status. `orderStages` are the stages of the
 * orders the change touches; a blank one is an order being deleted with its lines.
 */
export function disposalScopeRefusal(orderStages: readonly string[]): string {
    if (orderStages.every((stage) => stage === 'draft' || stage === '')) return ''
    return 'This disposal order has been submitted: its assets, methods and customer can no longer change'
}

/** The provider always approves; Customer admins too when a customer-owned Asset is involved. */
export function disposalApprovers(owners: ReadonlyArray<LegalOwner | ''>): Approver[] {
    return owners.includes('customer') ? ['account_manager', 'customer_admin'] : ['account_manager']
}
