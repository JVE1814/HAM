export function appendTo<K, V>(lists: Map<K, V[]>, key: K, value: V): void {
    const list = lists.get(key)
    if (list) list.push(value)
    else lists.set(key, [value])
}

export function chunks<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = []
    for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + Math.max(1, size)))
    return out
}

/**
 * The first of `items` none ranks above (`compare(a, b) > 0` when `a` does), or undefined for none. A scan, not a
 * sort: the platform's Array sort need not keep equal items in the order given, and ties go to the first.
 */
export function firstBest<T>(items: readonly T[], compare: (a: T, b: T) => number): T | undefined {
    let best: T | undefined
    for (const item of items) if (best === undefined || compare(item, best) > 0) best = item
    return best
}
