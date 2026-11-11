import { FEE_STATUS, type FeeType } from './vocabulary.ts'

/** What makes two Fee events the same charge: one type, for one Asset on one Return order (that is, its line). */
export interface FeeIdentity {
    type: FeeType
    assetId: string
    returnOrderId: string
}

/** The x_daas_ham_fee_event query for the charges of `fee` that count, any not waived: it is charged at most once. */
export function chargedFeeQuery(fee: FeeIdentity): string {
    return `fee_type=${fee.type}^asset=${fee.assetId}^return_order=${fee.returnOrderId}^status!=${FEE_STATUS.waived}`
}
