/** Add `value` to the list kept under `key`, starting the list if there is none. */
export function appendTo<K, V>(lists: Map<K, V[]>, key: K, value: V): void {
    const list = lists.get(key)
    if (list) list.push(value)
    else lists.set(key, [value])
}
