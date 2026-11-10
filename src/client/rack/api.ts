import type { RackElevation, RackList, SiteList } from '../../server/domain/rest-contracts'
import { get, path } from '../api'

/** Each call takes a `signal`, which aborts it when the page's selection has moved past its answer. */
export const rackApi = {
    sites: (signal?: AbortSignal) => get<SiteList>('/sites', signal).then((r) => r.sites),
    racks: (siteId: string, signal?: AbortSignal) => get<RackList>(path`/racks?site=${siteId}`, signal).then((r) => r.racks),
    rack: (rackId: string, signal?: AbortSignal) => get<RackElevation>(path`/racks/${rackId}`, signal),
}
