import type { CustomerAsset } from '../../server/domain/rest-contracts'

/** The equipment per Site, Sites and devices in the order the server sent them. '' is the devices with no Site. */
export function bySite(assets: readonly CustomerAsset[]): Map<string, CustomerAsset[]> {
    const sites = new Map<string, CustomerAsset[]>()
    for (const asset of assets) {
        const at = sites.get(asset.siteId)
        if (at) at.push(asset)
        else sites.set(asset.siteId, [asset])
    }
    return sites
}

/** The device count as the page writes it: "5000+" when the server cut the list. */
export function equipmentCount(count: number, truncated: boolean): string {
    return truncated ? `${count}+` : String(count)
}
