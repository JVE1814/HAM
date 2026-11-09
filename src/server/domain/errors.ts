/** What a script, record or write threw, as text. */
export function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
