export function appendTo<K, V>(lists: Map<K, V[]>, key: K, value: V): void {
    const list = lists.get(key)
    if (list) list.push(value)
    else lists.set(key, [value])
}

/** `items` cut into runs of `size` (at least 1), in order; the last holds what is left. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = []
    for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + Math.max(1, size)))
    return out
}
