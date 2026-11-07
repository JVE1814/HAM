import { gs, type GlideRecord } from '@servicenow/glide'

/** Events this app fires (registered in src/fluent/logic/events.now.ts). */
export const EVENT = {
    sourceOrder: 'x_daas_ham.order.source',
    lifecycleChanged: 'x_daas_ham.model.lifecycle',
    agreementTermsChanged: 'x_daas_ham.agreement.terms',
    returnOverdue: 'x_daas_ham.return.overdue',
    leaseAssets: 'x_daas_ham.lease.assets',
    leaseBuyout: 'x_daas_ham.lease.buyout',
    billingExport: 'x_daas_ham.billing.export',
    leaseMismatch: 'x_daas_ham.lease.mismatch',
    agreementRenewal: 'x_daas_ham.agreement.renewal',
    coverageExpiring: 'x_daas_ham.coverage.expiring',
    billingGenerate: 'x_daas_ham.billing.generate',
    marginCompute: 'x_daas_ham.margin.compute',
} as const

export function fire(event: string, record: GlideRecord, parm1 = '', parm2 = ''): void {
    gs.eventQueue(event, record, parm1, parm2)
}
