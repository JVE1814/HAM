import { runSparePoolTopUp } from '../platform/spare-pools.ts'

/** Daily job: keep every Customer's Spare pool at its Agreement's spare-pool ratio (platform/spare-pools). */
export function topUpSparePools(): void {
    runSparePoolTopUp()
}
