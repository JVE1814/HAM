/**
 * How a scanned or reported identifier names an Asset (warehouse scans P1.5, device events P1.8): by its serial number,
 * else its Provider tag, else its Customer tag, the first of these fields any Asset carries it in. A serial and a
 * Provider tag each name one unit; a Customer tag is the Customer's own, so two Customers may both tag a switch SW-01.
 * An identifier that two Assets carry in that field names neither: which one is meant cannot be told, so it is
 * refused, never guessed (a sighting would put the other Customer's Asset in service and start billing it).
 */

/** The fields an identifier is looked for in, in the order they take precedence. */
export const IDENTIFIER_FIELDS = [
    { field: 'serial_number', label: 'serial number' },
    { field: 'asset_tag', label: 'Provider tag' },
    { field: 'x_daas_ham_customer_tag', label: 'Customer tag' },
] as const

export type IdentifierField = (typeof IDENTIFIER_FIELDS)[number]

/** How many Assets carrying the identifier in one field are read: two are enough to tell it is ambiguous. */
export const IDENTIFIER_READ_LIMIT = 2

export type FieldMatch = { kind: 'none' } | { kind: 'one'; index: number } | { kind: 'ambiguous' }

/**
 * Which of the Assets carrying the identifier in one field it names, from whether each is a fleet asset (ADR 0016), as
 * read: at most IDENTIFIER_READ_LIMIT, fleet assets first when the Provider IT's are read too. A fleet asset is chosen
 * over the Provider IT's that carries the same identifier (a receipt takes in the fleet one and never makes a second
 * Asset for a serial IT holds); two fleet assets, or two of the Provider IT's, are ambiguous.
 */
export function fieldMatch(fleet: readonly boolean[]): FieldMatch {
    if (fleet.length === 0) return { kind: 'none' }
    if (fleet.length === 1) return { kind: 'one', index: 0 }
    return fleet[0] && !fleet[1] ? { kind: 'one', index: 0 } : { kind: 'ambiguous' }
}

/** Why an ambiguous identifier is refused, for the person who scanned it or the integration that sent it. */
export function ambiguousIdentifier(identifier: string, field: IdentifierField): string {
    const others = IDENTIFIER_FIELDS.filter((other) => other.field !== field.field).map((other) => other.label)
    return `More than one asset has ${field.label} ${identifier}: use its ${others.join(' or ')} instead`
}
