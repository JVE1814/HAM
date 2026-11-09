import type {
    AttestationItem,
    AttestationReceipt,
    CustomerOverview,
    FaultReport,
    InstallConfirmation,
    ReturnRequestReceipt,
} from '../../server/domain/rest-contracts'
import { get, path, post } from '../api'

export const customerApi = {
    overview: () => get<CustomerOverview>('/customer/overview'),
    reportFault: (asset: string, description: string) => post<FaultReport>('/customer/faults', { asset, description }),
    confirmInstalled: (orderId: string) => post<InstallConfirmation>(path`/customer/orders/${orderId}/installed`),
    answerAttestation: (id: string, items: Array<Pick<AttestationItem, 'id' | 'response'>>, submit: boolean) =>
        post<AttestationReceipt>(path`/customer/attestations/${id}`, { items, submit }),
    requestReturn: (input: { site: string; assets: string[]; decommission: boolean; method: string }) =>
        post<ReturnRequestReceipt>('/customer/returns', input),
}
