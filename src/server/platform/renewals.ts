import { GlideRecord } from '@servicenow/glide'
import { withinLead } from '../domain/calendar.ts'
import { EVENT } from '../domain/events.ts'
import { recoversAgainAt, renewedEnd } from '../domain/renewals.ts'
import { providerApproverIds } from './approvals.ts'
import { todayIso } from './clock.ts'
import { fire } from './events.ts'
import { num, str, warnRefused } from './records.ts'
import { recoverAgainAtEnd } from './scheduled-returns.ts'

/**
 * The Agreement's `renewal_notified` mark, which makes the warning go once per end date, is read and written here
 * only.
 */

const RENEWAL_WARNED = 'renewal_notified'

/** Warn the account manager of each Agreement coming up for renewal (or, without an active one, the asset managers), once. */
export function warnAgreementRenewals(today: string): void {
    const agreement = new GlideRecord('x_daas_ham_agreement')
    agreement.addQuery(RENEWAL_WARNED, false)
    agreement.addNotNullQuery('ends')
    agreement.addQuery('ends', '>=', today)
    agreement.query()
    while (agreement.next()) {
        if (!withinLead(str(agreement, 'ends'), today, num(agreement, 'renewal_lead_days'))) continue
        agreement.setValue(RENEWAL_WARNED, true)
        // Refused: tomorrow's run warns again, which beats not warning at all.
        if (!agreement.update()) warnRefused(agreement, `Agreement ${str(agreement, 'number')} not marked warned`)
        fire(EVENT.agreementRenewal, agreement, providerApproverIds(str(agreement, 'account_manager')).join(','))
    }
}

/**
 * An Agreement's end date changed (the caller saves it): the renewal warning goes again ahead of the new end, and an
 * Agreement that has not ended by it has its equipment recovered again once it has (domain/renewals `recoversAgainAt`).
 */
export function rearmForNewEnd(agreement: GlideRecord): void {
    agreement.setValue(RENEWAL_WARNED, false)
    if (recoversAgainAt(str(agreement, 'ends'), todayIso())) recoverAgainAtEnd(agreement)
}

/**
 * What came of renewing an Agreement: its new end date, or why it was not renewed. `why` is '' when the platform has
 * told the user already: it refused the save of the form the Agreement was renewed from.
 */
export type Renewal = { renewed: true; until: string } | { renewed: false; why: string }

/**
 * Renew an Agreement: its end date moves on by its renewal term (domain/renewals `renewedEnd`), and its warning and its
 * end-of-agreement return are re-armed, whatever the new end. Saves the Agreement, the record of the form it was asked
 * from.
 */
export function renewAgreement(agreement: GlideRecord): Renewal {
    if (!str(agreement, 'ends')) return { renewed: false, why: 'The agreement has no end date to renew' }
    const ends = renewedEnd(str(agreement, 'ends'), num(agreement, 'renewal_term_months'))
    agreement.setValue('ends', ends)
    agreement.setValue(RENEWAL_WARNED, false)
    recoverAgainAtEnd(agreement)
    return agreement.update() ? { renewed: true, until: ends } : { renewed: false, why: '' }
}
