import { queryOptions } from '@tanstack/react-query'
import type { RackElevation, RackList, SiteList } from '../../server/domain/rest-contracts'
import { get, path } from '../api'

export const rackApi = {
    sites: (signal?: AbortSignal) => get<SiteList>('/sites', signal).then((r) => r.sites),
    racks: (siteId: string, signal?: AbortSignal) => get<RackList>(path`/racks?site=${siteId}`, signal).then((r) => r.racks),
    rack: (rackId: string, signal?: AbortSignal) => get<RackElevation>(path`/racks/${rackId}`, signal),
}

export const sitesQuery = queryOptions({ queryKey: ['sites'], queryFn: ({ signal }) => rackApi.sites(signal) })

export const racksQuery = (siteId: string) => queryOptions({ queryKey: ['sites', siteId, 'racks'], queryFn: ({ signal }) => rackApi.racks(siteId, signal) })

export const rackQuery = (rackId: string) => queryOptions({ queryKey: ['racks', rackId], queryFn: ({ signal }) => rackApi.rack(rackId, signal) })
