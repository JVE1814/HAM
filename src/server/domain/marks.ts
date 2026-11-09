/**
 * Items marked while a callback runs, compared by identity (`===`). `during(item, run)` marks `item` for as long as
 * `run` runs and unmarks it however `run` ends, returning or throwing; a nested `during` of the same item keeps it
 * marked until the outermost one ends.
 */
export interface Marks<T> {
    during<R>(item: T, run: () => R): R
    has(item: T): boolean
}

export function createMarks<T>(): Marks<T> {
    // One entry per `during` still running, so an item marked twice is listed twice.
    const marked: T[] = []
    return {
        during(item, run) {
            marked.push(item)
            try {
                return run()
            } finally {
                marked.splice(marked.lastIndexOf(item), 1)
            }
        },
        has: (item) => marked.includes(item),
    }
}
