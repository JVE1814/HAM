// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { gs, type GlideRecord } from '@servicenow/glide'
import { agreementCurrencyProblem } from '../domain/billing.ts'
import { currencyCode } from '../domain/money.ts'
import { queueRefresh, runRefreshPass } from '../platform/lifecycle-dates.ts'
import { str } from '../platform/records.ts'
import { rearmForNewEnd, renewAgreement } from '../platform/renewals.ts'
import { abortWith } from '../platform/rule-api.ts'

/** Agreements: their currency, their refresh terms, and their renewal (plan §13 Renewals). */

/**
 * Before insert/update rule on Agreements (when the currency changes): a currency that is no three-letter code is
 * refused as it is entered (domain/billing `agreementCurrencyProblem`), rather than failing every line of the Agreement
 * at the next generation; one entered in lower case is saved upper-cased, as billing reads it.
 */
export function guardAgreementCurrency(current: GlideRecord): void {
    const entered = str(current, 'currency')
    const problem = agreementCurrencyProblem(entered)
    if (problem) return abortWith(current, problem)
    const code = currencyCode(entered)
    if (code && code !== entered) current.setValue('currency', code)
}

export function onAgreementTermsChanged(current: GlideRecord): void {
    queueRefresh('agreement', current)
}

export function refreshAgreementAssets(event: GlideRecord, current: GlideRecord): void {
    runRefreshPass('agreement', event, current)
}

export function onAgreementEndChanged(current: GlideRecord): void {
    rearmForNewEnd(current)
}

export function uiRenewAgreement(current: GlideRecord): void {
    const renewal = renewAgreement(current)
    if (renewal.renewed) gs.addInfoMessage(`Agreement renewed until ${renewal.until}`)
    else if (renewal.why) gs.addErrorMessage(renewal.why)
}
