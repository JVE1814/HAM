import { addMonths, daysBetween, endOfMonth } from './calendar.ts'

/** Amounts, currencies and billing months, as every money workflow (billing, Margin, leases, shipping) counts them. */

export interface MonthBounds {
    /** YYYY-MM */
    month: string
    first: string
    last: string
    days: number
}

export function isMonth(value: string): boolean {
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

/** The first and last day and the length of a YYYY-MM month; throws for any other value. */
export function monthBounds(month: string): MonthBounds {
    if (!isMonth(month)) throw new Error(`'${month}' is not a YYYY-MM month`)
    const first = `${month}-01`
    const last = endOfMonth(first)
    return { month, first, last, days: daysBetween(first, last) + 1 }
}

/**
 * An encoded query for records whose date range (end blank = still open) overlaps the month.
 * The ^OR binds to the end-date clause only: start <= last AND (end empty OR end >= first).
 */
export function overlapsMonth(bounds: MonthBounds): string {
    return `start_date<=${bounds.last}^end_dateISEMPTY^ORend_date>=${bounds.first}`
}

/** An encoded query for records whose date-time `field` falls on a day of the month. */
export function timeInMonth(field: string, bounds: MonthBounds): string {
    return `${field}>=${bounds.first} 00:00:00^${field}<=${bounds.last} 23:59:59`
}

export function previousMonth(today: string): string {
    return addMonths(`${today.slice(0, 7)}-01`, -1).slice(0, 7)
}

/** Days from `from` to `to` (both inclusive; open-ended without `to`) that fall in the month. */
export function activeDays(bounds: MonthBounds, from: string, to?: string): number {
    if (!from) return 0
    const start = from > bounds.first ? from : bounds.first
    const end = to && to < bounds.last ? to : bounds.last
    return end < start ? 0 : daysBetween(start, end) + 1
}

/*
 * Money is rounded in whole cents, half away from zero. Binary fractions cannot hold most decimal amounts (1.005 is
 * stored as 1.00499...), so rounding `amount * 100` directly would round many half-cents down.
 */

/** An amount as whole cents, rounded half away from zero; the binary noise of a decimal amount is ignored (1.005 is 101). */
export function toCents(amount: number): number {
    if (!Number.isFinite(amount)) return 0
    const rounded = Math.round(Number((Math.abs(amount) * 100).toPrecision(15)))
    return (amount < 0 ? -rounded : rounded) || 0
}

export function fromCents(cents: number): number {
    return cents / 100
}

export function roundToCent(amount: number): number {
    return fromCents(toCents(amount))
}

/**
 * `numerator / denominator` for integers (denominator not 0), rounded half away from zero, exactly: the quotient a float
 * division gives is corrected by its remainder, so a half is never lost to binary rounding.
 */
export function divideRounded(numerator: number, denominator: number): number {
    const negative = numerator < 0 !== denominator < 0
    const n = Math.abs(numerator)
    const d = Math.abs(denominator)
    let quotient = Math.floor(n / d)
    let remainder = n - quotient * d
    if (remainder < 0) {
        quotient--
        remainder += d
    } else if (remainder >= d) {
        quotient++
        remainder -= d
    }
    const rounded = 2 * remainder >= d ? quotient + 1 : quotient
    return (negative ? -rounded : rounded) || 0
}

/*
 * Currency (the owner's decision): each Agreement bills in one currency, a mandatory field with no default. Its Billing
 * lines and Cost facts are kept in it, and no amounts of two currencies are ever added: totals and Margin are kept per
 * currency. A shipment's cost is the exception: it stays in the carrier's currency, and Margin counts it in that one.
 */

/** A currency code as entered (ISO 4217: three letters, any case), upper-cased; '' for anything else. */
export function currencyCode(value: string): string {
    const code = value.trim()
    return /^[A-Za-z]{3}$/.test(code) ? code.toUpperCase() : ''
}

/**
 * A stored currency as totals and Margin group it: its code (currencyCode), else as stored, trimmed (so a value that is
 * no code is still kept apart from every other, never merged into one).
 */
export function currencyKey(value: string): string {
    return currencyCode(value) || value.trim()
}

/** An Agreement an amount names, for its currency: `name` (its number) for messages, and its Currency as stored. */
export interface AgreementCurrency {
    name: string
    currency: string
}

type CurrencyChoice = { currency: string } | { problem: string }

/**
 * The currency an amount is billed or costed in, never a default: its Agreement's, when it names one. One that names
 * none (a fee entered by hand, a site audit's work order) takes the currency every Agreement of its Customer has
 * (`customerCurrencies`, as stored, read only then); a Customer whose Agreements have several, or none, leaves it
 * without one. A choice without a currency says why, to fix the Agreement (or name one) and run the job again.
 */
export function chooseCurrency(agreement: AgreementCurrency | null, customerCurrencies: () => readonly string[]): CurrencyChoice {
    if (agreement) {
        const currency = currencyCode(agreement.currency)
        if (currency) return { currency }
        const stored = agreement.currency.trim()
        const why = stored ? `'${stored}' as its currency, not a three-letter code` : 'no currency'
        return { problem: `its Agreement ${agreement.name} has ${why}: set the Agreement's currency` }
    }
    const codes = [...new Set(customerCurrencies().map(currencyCode))].sort()
    if (codes.length === 1 && codes[0]) return { currency: codes[0] }
    const has = codes.length === 0 ? 'none' : codes.map((code) => code || 'no currency').join(', ')
    return { problem: `it names no Agreement, and its Customer's Agreements are in ${has}: set its Agreement` }
}

/** The currency chosen; throws with why there is none, so the line or cost fails (and is counted) instead of guessing one. */
export function currencyOrThrow(choice: CurrencyChoice): string {
    if ('problem' in choice) throw new Error(`no currency: ${choice.problem}`)
    return choice.currency
}
