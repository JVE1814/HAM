import { queryOptions } from '@tanstack/react-query'
import type {
    AttestationAnswers,
    AttestationReceipt,
    CustomerOverview,
    FaultReport,
    FaultRequest,
    InstallConfirmation,
    ReturnRequestBody,
    ReturnRequestReceipt,
} from '../../server/domain/rest-contracts'
import { get, path, post } from '../api'

export const customerApi = {
    overview: (signal?: AbortSignal) => get<CustomerOverview>('/customer/overview', signal),
    reportFault: (asset: string, description: string) => post<FaultReport>('/customer/faults', { asset, description } satisfies FaultRequest),
    confirmInstalled: (orderId: string) => post<InstallConfirmation>(path`/customer/orders/${orderId}/installed`),
    answerAttestation: (id: string, items: AttestationAnswers['items'], submit: boolean) =>
        post<AttestationReceipt>(path`/customer/attestations/${id}`, { items, submit } satisfies AttestationAnswers),
    requestReturn: (input: ReturnRequestBody) => post<ReturnRequestReceipt>('/customer/returns', input),
}

export const overviewKey = ['customer', 'overview'] as const

export const overviewQuery = queryOptions({
    queryKey: overviewKey,
    queryFn: ({ signal }) => customerApi.overview(signal),
})
