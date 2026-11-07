import { GlideAggregate, GlideRecord } from '@servicenow/glide'
import { DEPLOYED_STAGES, stagesQuery } from '../domain/lifecycle'
import { pickForSparePool, sparePoolShortfall } from '../domain/sourcing'
import { moveAsset } from '../platform/assets'
import { runTableJob } from '../platform/chunked'
import { openPurchaseQuantity, requestPurchase } from '../platform/procurement'
import { boolProperty, PROPERTY, stringProperty } from '../platform/properties'
import { num, str } from '../platform/records'
import { stockCandidates } from '../platform/stock'

/** Daily job: keep every Customer's Spare pool at its Agreement's spare-pool ratio (P1.4). */
export function topUpSparePools(): void {
    runTableJob({
        job: 'spare_pool_top_up',
        table: 'x_daas_ham_agreement',
        query: 'state=active^spare_pool_ratio>0',
        read: (agreement) => ({ customerId: str(agreement, 'customer'), ratio: num(agreement, 'spare_pool_ratio') }),
        handle: (agreement, agreementId) => topUpAgreement(agreementId, agreement.customerId, agreement.ratio),
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

function topUpAgreement(agreementId: string, customerId: string, ratio: number): void {
    const deployed = countByModel(stagesQuery(DEPLOYED_STAGES, `x_daas_ham_agreement=${agreementId}`))
    const reserved = countByModel(stagesQuery(['spare_pool'], `company=${customerId}`))
    const stagingStockroom = stringProperty(PROPERTY.stagingStockroom)
    for (const [modelId, deployedCount] of deployed) {
        const shortfall = sparePoolShortfall({ deployed: deployedCount, reserved: reserved.get(modelId) ?? 0, ratio })
        if (shortfall === 0) continue
        const picked = pickForSparePool(stockCandidates(modelId, shortfall * 5 + 50), modelId, shortfall)
        for (const assetId of picked) {
            const asset = new GlideRecord('alm_hardware')
            if (!asset.get(assetId) || !moveAsset(asset, 'spare_pool').allowed) continue
            asset.setValue('company', customerId)
            asset.setValue('x_daas_ham_agreement', agreementId)
            asset.update()
        }
        if (!boolProperty(PROPERTY.autoPurchaseSpares, false)) continue
        const prefix = `Spare-pool top-up ${agreementId}:`
        const missing = shortfall - picked.length - openPurchaseQuantity(prefix, modelId)
        if (missing > 0) requestPurchase({ modelId, quantity: missing, shipToStockroomId: stagingStockroom, description: `${prefix} ${missing} unit(s)` })
    }
}
