import { GlideAggregate, gs } from '@servicenow/glide'
import { DEPLOYED_STAGES, stagesQuery } from '../domain/lifecycle'
import { freeStockOf, pickForSparePool, sparePoolShortfall } from '../domain/sourcing'
import { runTableJob } from '../platform/chunked'
import { openPurchaseQuantity, requestPurchase } from '../platform/procurement'
import { boolProperty, PROPERTY, stagingStockroom } from '../platform/properties'
import { num, str } from '../platform/records'
import { moveToSparePool, stockCandidates } from '../platform/stock'

/** Daily job: keep every Customer's Spare pool at its Agreement's spare-pool ratio (P1.4). */
export function topUpSparePools(): void {
    const autoPurchase = boolProperty(PROPERTY.autoPurchaseSpares, false) && canPurchase()
    runTableJob({
        job: 'spare_pool_top_up',
        table: 'x_daas_ham_agreement',
        query: 'state=active^spare_pool_ratio>0',
        read: (agreement) => ({ customerId: str(agreement, 'customer'), ratio: num(agreement, 'spare_pool_ratio') }),
        handle: (agreement, agreementId) => topUpAgreement(agreementId, agreement.customerId, agreement.ratio, autoPurchase),
    })
}

function countByModel(query: string): Map<string, number> {
    const ga = new GlideAggregate('alm_hardware')
    ga.addEncodedQuery(query)
    ga.addAggregate('COUNT', '')
    ga.groupBy('model')
    ga.query()
    const counts = new Map<string, number>()
    while (ga.next()) counts.set(String(ga.getValue('model') ?? ''), Number(ga.getAggregate('COUNT', '')))
    return counts
}

/** Purchased spares ship to the staging stockroom: without one, the run buys none and says so once. */
function canPurchase(): boolean {
    if (stagingStockroom()) return true
    gs.warn(`[x_daas_ham] Spare-pool top-up buys no spares: set ${PROPERTY.stagingStockroom}`)
    return false
}

/** Move free central stock into the Customer's Spare pool, and buy what is still missing when `autoPurchase`. */
function topUpAgreement(agreementId: string, customerId: string, ratio: number, autoPurchase: boolean): void {
    const deployed = countByModel(stagesQuery(DEPLOYED_STAGES, `x_daas_ham_agreement=${agreementId}`))
    const reserved = countByModel(stagesQuery(['spare_pool'], `company=${customerId}`))
    for (const [modelId, deployedCount] of deployed) {
        const shortfall = sparePoolShortfall({ deployed: deployedCount, reserved: reserved.get(modelId) ?? 0, ratio })
        if (shortfall === 0) continue
        const picked = pickForSparePool(stockCandidates(freeStockOf(modelId), shortfall * 5 + 50), modelId, shortfall)
        // A unit sourcing claimed in the meantime (or whose save was refused) is not moved and stays in the shortfall.
        const moved = picked.filter((assetId) => moveToSparePool(assetId, customerId, agreementId)).length
        if (!autoPurchase) continue
        const prefix = `Spare-pool top-up ${agreementId}:`
        const missing = shortfall - moved - openPurchaseQuantity(prefix, modelId)
        if (missing > 0) requestPurchase({ modelId, quantity: missing, description: `${prefix} ${missing} unit(s)` })
    }
}
