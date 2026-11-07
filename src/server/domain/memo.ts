/** `read` remembering each key's result for the returned reader's lifetime (create one per job chunk or request). */
export function memoized<T>(read: (key: string) => T): (key: string) => T {
    const seen = new Map<string, T>()
    return (key) => {
        if (!seen.has(key)) seen.set(key, read(key))
        return seen.get(key) as T
    }
}
