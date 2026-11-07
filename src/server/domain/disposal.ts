import type { Approver } from './entitlement'
import type { LegalOwner, Stage } from './lifecycle'

/** Disposal orders (P2.5, D61). */

export type DisposalMethod = 'broker_resale' | 'oem_takeback' | 'itad_recycle' | 'return_to_customer' | 'return_to_lessor'

const STAGE: Record<DisposalMethod, Stage> = {
    broker_resale: 'sold',
    oem_takeback: 'returned_to_oem',
    itad_recycle: 'disposed',
    return_to_customer: 'returned_to_customer',
    return_to_lessor: 'returned_to_lessor',
}

const ALLOWED: Record<Exclude<LegalOwner, ''>, readonly DisposalMethod[]> = {
    provider: ['broker_resale', 'oem_takeback', 'itad_recycle'],
    customer: ['return_to_customer'],
    lessor: ['return_to_lessor'],
}

export function disposalStage(method: DisposalMethod): Stage {
    return STAGE[method]
}

/** Why a line cannot be completed yet (empty when it can). */
export function disposalLineBlockers(line: { legalOwner: LegalOwner; method: DisposalMethod; wipeComplete: boolean; stage: Stage | null }): string[] {
    const owner = line.legalOwner || 'provider'
    const blockers: string[] = []
    if (line.stage !== 'pending_wipe' && line.stage !== 'pending_disposal') {
        blockers.push(`asset is ${line.stage ?? 'in an unmodelled stage'}, not awaiting wipe or disposal`)
    }
    if (!ALLOWED[owner].includes(line.method)) {
        blockers.push(`a ${owner}-owned asset can only be ${ALLOWED[owner].map((m) => m.replace(/_/g, ' ')).join(' or ')}`)
    }
    if (!line.wipeComplete) blockers.push('no wipe evidence')
    return blockers
}

/** The provider always approves; Customer admins too when a customer-owned Asset is involved. */
export function disposalApprovers(owners: readonly LegalOwner[]): Approver[] {
    return owners.includes('customer') ? ['account_manager', 'customer_admin'] : ['account_manager']
}
