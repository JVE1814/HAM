import type { VisibilityScope } from './visibility.ts'

/**
 * Who may ask for something on a Customer's behalf, and whether what the request names is that Customer's: the one rule
 * an Order (domain/entitlement) and a requested Return (domain/returns) both follow. Each names what it asks for in
 * the sentences (`ActWording`); the rule and the rest of the wording are here only.
 */

/**
 * A record a request names, with the Customer it belongs to: '' for none (a Site template offered to every Customer),
 * null when it cannot be read.
 */
export interface NamedRecord {
    id: string
    customerId: string | null
}

export type NamedSite = NamedRecord & { isSite: boolean }

/**
 * The person asking: whether the create rule of what they ask for lets them at all, how far they see (ADR 0005) and
 * their own Customer.
 */
export interface CustomerActor {
    permitted: boolean
    scope: VisibilityScope
    customerId: string
}

/** What is asked for, as the refusals name it: "You may not `act`", "You can only `actForOwn` for your own customer". */
export interface ActWording {
    act: string
    actForOwn: string
}

/**
 * Why this person may not ask for the Customer, or null when they may. Only those the create rule lets in ask at all,
 * and site contacts never do; provider staff and the service desk ask for any Customer, a customer admin only for
 * their own.
 */
export function actorRefusal(customerId: string, actor: CustomerActor, wording: ActWording): string | null {
    if (!actor.permitted || actor.scope === 'own_sites') return `You may not ${wording.act}`
    if (actor.scope === 'own_customer' && customerId !== actor.customerId) return `You can only ${wording.actForOwn} for your own customer`
    return null
}

/** What a request that names no Customer is told: nothing it names can be checked against one. */
export const CHOOSE_CUSTOMER = 'Choose the customer'

function notOwn(noun: 'agreement' | 'site', customerId: string, record: NamedRecord | undefined, genuine: boolean): string | null {
    if (!record) return `Choose one of the customer's ${noun}s`
    return genuine && record.customerId === customerId ? null : `The ${noun} is not one of the customer's ${noun}s`
}

export function agreementFinding(customerId: string, agreement: NamedRecord | undefined): string | null {
    return notOwn('agreement', customerId, agreement, true)
}

export function siteFinding(customerId: string, site: NamedSite | undefined): string | null {
    return notOwn('site', customerId, site, !!site?.isSite)
}
