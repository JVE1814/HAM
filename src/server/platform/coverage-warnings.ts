import { GlideRecord } from '@servicenow/glide'
import { addDays } from '../domain/calendar.ts'
import { groupExpiringCoverage, type ExpiringCoverage } from '../domain/coverage.ts'
import { fleetStagesQuery } from '../domain/fleet.ts'
import { SERVING_STAGES } from '../domain/lifecycle.ts'
import { assetManagerIds } from './approvals.ts'
import { markExpiryWarned } from './coverage.ts'
import { EVENT, fire } from './events.ts'
import { intProperty, PROPERTY } from './properties.ts'
import { findById, str, warnRefused } from './records.ts'

/**
 * The warning ahead of expiring OEM coverage (P3.24). It goes once per contract, which the contract's `expiry_notified`
 * mark records: platform/coverage sets it for this module (`markExpiryWarned`) and clears it when the contract's end
 * date moves.
 */

/**
 * One warning per Customer for covered, deployed fleet assets whose OEM coverage ends soon; each contract is
 * warned about once. Exactly the rows counted are marked (a daily job, at most 5000 contracts a run); a row
 * whose mark is refused is logged and counted again the next day, which beats not warning at all.
 */
export function warnExpiringCoverage(today: string): void {
    const horizon = addDays(today, intProperty(PROPERTY.coverageWarningDays))
    const coverage = new GlideRecord('x_daas_ham_oem_coverage')
    coverage.addEncodedQuery(fleetStagesQuery(SERVING_STAGES, `covered=true^expiry_notified=false^end_date>=${today}^end_date<=${horizon}`, 'asset.'))
    coverage.setLimit(5000)
    coverage.query()
    const rows: ExpiringCoverage[] = []
    while (coverage.next()) {
        rows.push({ customerId: str(coverage, 'asset.company'), endDate: str(coverage, 'end_date') })
        if (!markExpiryWarned(coverage)) {
            const contract = `${str(coverage, 'contract_number')} of ${str(coverage, 'serial_number')}`
            warnRefused(coverage, `Coverage ${contract} not marked warned`)
        }
    }
    const recipients = assetManagerIds().join(',')
    for (const [customerId, group] of groupExpiringCoverage(rows)) {
        const customer = findById('customer_account', customerId)
        if (customer) fire(EVENT.coverageExpiring, customer, recipients, `${group.count} OEM coverage contract(s), the first ending ${group.firstEnd}`)
    }
}
