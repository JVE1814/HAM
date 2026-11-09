import { runTableJob } from '../platform/chunked.ts'
import { num, str } from '../platform/records.ts'
import { sparePurchasesEnabled, topUpAgreementPools } from '../platform/spare-pools.ts'

/** Daily job: keep every Customer's Spare pool at its Agreement's spare-pool ratio (platform/spare-pools). */
export function topUpSparePools(): void {
    const autoPurchase = sparePurchasesEnabled()
    runTableJob({
        job: 'spare_pool_top_up',
        table: 'x_daas_ham_agreement',
        query: 'state=active^spare_pool_ratio>0',
        read: (agreement) => ({ customerId: str(agreement, 'customer'), ratio: num(agreement, 'spare_pool_ratio') }),
        handle: (agreement, agreementId) => topUpAgreementPools({ agreementId, ...agreement }, autoPurchase),
    })
}
