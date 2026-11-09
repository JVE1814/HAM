/**
 * Closed sets of values the app reads from records (choice fields, stages) and switches over. A value read from a
 * record is only text: one the app does not know (a corrupt row, a choice an administrator added) must not pass as one
 * it does. So it is checked against its set (`oneOf`; platform/records `choice` reads a field that way), and a switch
 * over a checked value ends in `assertNever`, which the compiler proves unreachable.
 */

/** `value` when it is one of `allowed`, else undefined. */
export function oneOf<T extends string>(value: string, allowed: readonly T[]): T | undefined {
    return (allowed as readonly string[]).includes(value) ? (value as T) : undefined
}

/**
 * The default branch of a switch that covers every member of a union: the compiler refuses it while a member is left
 * out, and should a value the type does not allow reach it all the same (cast past a check), it throws rather than
 * pass as some other member.
 */
export function assertNever(value: never, what = 'value'): never {
    throw new Error(`Unexpected ${what}: ${String(value)}`)
}
