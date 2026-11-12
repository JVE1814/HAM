import { GlideRecord } from '@servicenow/glide'
import { appendTo } from '../domain/collections.ts'
import { fleetStagesQuery } from '../domain/fleet.ts'
import { INSTALLED_STAGES, type Stage } from '../domain/lifecycle.ts'
import { str } from './records.ts'

interface InstalledFilter {
    agreementId?: string
    siteId?: string
    orderId?: string
    /** The stages listed: a Return passes those it takes back (domain/returns `stagesTakenBack`). */
    stages?: readonly Stage[]
}

/**
 * Fleet assets installed at a Site (in service, temporary or awaiting first sighting, unless `stages` says otherwise),
 * by Agreement, Site or Order. The Provider IT's equipment is never listed (ADR 0016).
 */
export function installedAssetIds(filter: InstalledFilter): string[] {
    const asset = queryInstalled(filter)
    const ids: string[] = []
    while (asset.next()) ids.push(asset.getUniqueValue())
    return ids
}

/** The installed Assets (as installedAssetIds) under the Site each is at. */
export function installedAssetIdsBySite(filter: InstalledFilter): Map<string, string[]> {
    const asset = queryInstalled(filter)
    const bySite = new Map<string, string[]>()
    while (asset.next()) appendTo(bySite, str(asset, 'x_daas_ham_site'), asset.getUniqueValue())
    return bySite
}

function queryInstalled(filter: InstalledFilter): GlideRecord {
    const base = [
        filter.agreementId ? `x_daas_ham_agreement=${filter.agreementId}` : '',
        filter.siteId ? `x_daas_ham_site=${filter.siteId}` : '',
        filter.orderId ? `x_daas_ham_order_line.order=${filter.orderId}` : '',
    ]
        .filter(Boolean)
        .join('^')
    const asset = new GlideRecord('alm_hardware')
    asset.addEncodedQuery(fleetStagesQuery(filter.stages ?? INSTALLED_STAGES, base))
    asset.query()
    return asset
}
