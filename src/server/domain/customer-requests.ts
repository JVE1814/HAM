/**
 * The most devices one request of the customer page may list. The page lists devices it was shown: at most the 5000
 * of its equipment (platform/customer-page `customerEquipment`) in a return request, and the devices installed at one
 * Site in an attestation's answers. A handler reads a record for each entry, a return request while it holds its
 * Customer's return-request lock, so a longer list is refused unread.
 */
export const MAX_LISTED_DEVICES = 5000

export type SentList = { list: unknown[] } | { error: string }

/**
 * The list a customer page request names its devices in (the `assets` of a return request, the `items` of an
 * attestation's answers), as sent: anything but an array is an empty list, one over MAX_LISTED_DEVICES an error.
 */
export function sentDeviceList(raw: unknown): SentList {
    const list: unknown[] = Array.isArray(raw) ? raw : []
    if (list.length > MAX_LISTED_DEVICES) return { error: `At most ${MAX_LISTED_DEVICES} devices per request` }
    return { list }
}

/** The ids a sent list names, each once, in the order first named. */
export function uniqueIds(list: readonly unknown[]): string[] {
    return [...new Set(list.map(String))]
}
