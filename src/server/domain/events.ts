/**
 * The events this app fires, by name: the one list of them. The Fluent metadata registers each (a sysevent_register
 * record beside the script action or notification that answers it) under the name it imports from here, and the
 * server code fires and answers it by the same constant. Each entry says what the event's record and parameters carry.
 */
export const EVENT = {
    /**
     * An approved Order needs its lines sourced. Record: the Order; parm2: how often it was queued again. With parm1
     * `submit` (platform/orders `SUBMIT_AGAIN`) it carries a submission of the Order queued again instead.
     */
    sourceOrder: 'x_daas_ham.order.source',
    /** A Model's lifecycle milestones changed or one was crossed (event job). Record and parm1: the Model; parm2: cursor. */
    lifecycleChanged: 'x_daas_ham.model.lifecycle',
    /** An Agreement's refresh terms changed (event job). Record and parm1: the Agreement; parm2: cursor. */
    agreementTermsChanged: 'x_daas_ham.agreement.terms',
    /** Equipment on a Return order is overdue (notification). Record: the Return order; parm1: recipients; parm2: the Asset. */
    returnOverdue: 'x_daas_ham.return.overdue',
    /** Recompute the refresh due dates of a returned lease's Assets (event job). Record and parm1: the Lease schedule; parm2: cursor. */
    leaseAssets: 'x_daas_ham.lease.assets',
    /** Transfer a bought-out lease's Assets to the Provider (event job). Record and parm1: the Lease schedule; parm2: cursor. */
    leaseBuyout: 'x_daas_ham.lease.buyout',
    /** Attach the CSV export of a closed Billing period. Record and parm1: the period. */
    billingExport: 'x_daas_ham.billing.export',
    /** A lease ends before the Agreements its deployed Assets serve (notification). Record: the Lease schedule; parm1: recipients. */
    leaseMismatch: 'x_daas_ham.lease.mismatch',
    /** An Agreement is within its renewal lead time (notification). Record: the Agreement; parm1: recipients. */
    agreementRenewal: 'x_daas_ham.agreement.renewal',
    /** OEM coverage of a Customer's deployed Assets ends soon (notification). Record: the Customer; parm1: recipients; parm2: summary. */
    coverageExpiring: 'x_daas_ham.coverage.expiring',
    /** Generate the lines of a Billing period (event job). Record and parm1: the period; parm2: pass token and cursor. */
    billingGenerate: 'x_daas_ham.billing.generate',
    /** Compute the cost facts and margin of a closed Billing period (event job). Record and parm1: the period; parm2: pass token and cursor. */
    marginCompute: 'x_daas_ham.margin.compute',
    /** A Shipment's lock held off a tracking update. Record: the Shipment; parm1: the update (JSON); parm2: how often it was queued again. */
    trackShipment: 'x_daas_ham.shipment.track',
    /** A replacement Order is complete: its case is saved, so that its replacement SLA stops. Record: the Order. */
    replacementComplete: 'x_daas_ham.replacement.complete',
} as const
