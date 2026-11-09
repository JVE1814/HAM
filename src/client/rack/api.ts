import type { RackElevation, RackList, SiteList } from '../../server/domain/rest-contracts'
import { get, path } from '../api'

export const rackApi = {
    sites: () => get<SiteList>('/sites').then((r) => r.sites),
    racks: (siteId: string) => get<RackList>(path`/racks?site=${siteId}`).then((r) => r.racks),
    rack: (rackId: string) => get<RackElevation>(path`/racks/${rackId}`),
}
