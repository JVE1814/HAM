import type { AssetSummary, Stockroom, StockroomList } from '../../server/domain/rest-contracts'
import { ApiError, get, path, post } from '../api'

export const warehouseApi = {
    lookup: (code: string) => get<AssetSummary>(path`/assets/${code}`),
    receive: (input: { code: string; stockroom: string; pid?: string }) => post<AssetSummary>('/receive', input),
    putAway: (input: { code: string; stockroom: string }) => post<AssetSummary>('/putaway', input),
    pick: (input: { code: string; order: string }) => post<AssetSummary>('/pick', input),
    /** Audit scans are blind: the reply says nothing about the unit. */
    auditScan: (input: { audit: string; code: string }) => post<unknown>(path`/audits/${input.audit}/scan`, { code: input.code }),
    /** Stockrooms to receive into and put away to; null when the user may not do depot work (HTTP 403: field techs). */
    stockrooms: () =>
        get<StockroomList>('/stockrooms').then(
            (r): Stockroom[] | null => r.stockrooms,
            (error: unknown) => {
                if (error instanceof ApiError && error.status === 403) return null
                throw error
            },
        ),
}
