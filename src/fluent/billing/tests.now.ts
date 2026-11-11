import '@servicenow/sdk/global'
import { Test } from '@servicenow/sdk/core'
import { finance } from '../shared/roles.now'

/* ATF: billing period lock (Q66; suite "NaaS - P3"). */

export const closedBillingPeriodLockedTest = Test(
    {
        $id: Now.ID['atf_billing_locked'],
        name: 'NaaS - lines of a closed billing period cannot change',
        description: 'Updating a billing line of a closed period is refused.',
        active: true,
        failOnServerError: false,
    },
    (atf) => {
        const customer = atf.server.recordInsert({
            $id: Now.ID['atf_bl_customer'],
            table: 'customer_account',
            fieldValues: { name: 'ATF Billing Customer', customer: true },
        })
        const period = atf.server.recordInsert({
            $id: Now.ID['atf_bl_period'],
            table: 'x_daas_ham_billing_period',
            fieldValues: { period: '1999-01', status: 'closed' },
        })
        // A line as the generation writes it: its Agreement's currency (mandatory, no default; owner decision (b)), so
        // the update below is refused by the closed period's lock alone.
        const agreement = atf.server.recordInsert({
            $id: Now.ID['atf_bl_agreement'],
            table: 'x_daas_ham_agreement',
            fieldValues: { customer: customer.record_id, short_description: 'ATF billing agreement', state: 'active', currency: 'EUR' },
        })
        const line = atf.server.recordInsert({
            $id: Now.ID['atf_bl_line'],
            table: 'x_daas_ham_billing_line',
            fieldValues: {
                billing_period: period.record_id,
                kind: 'subscription',
                customer: customer.record_id,
                agreement: agreement.record_id,
                description: 'ATF line',
                amount: 100,
                currency: 'EUR',
            },
        })
        atf.server.createUser({ $id: Now.ID['atf_bl_user'], firstName: 'ATF', lastName: 'Finance', roles: [finance] })
        atf.server.recordUpdate({
            $id: Now.ID['atf_bl_update'],
            table: 'x_daas_ham_billing_line',
            recordId: line.record_id,
            fieldValues: { amount: 1 },
            assert: 'record_not_updated',
        })
        atf.server.recordValidation({
            $id: Now.ID['atf_bl_validate'],
            table: 'x_daas_ham_billing_line',
            recordId: line.record_id,
            fieldValues: 'amount=100',
            assert: 'record_validated',
        })
    },
)
