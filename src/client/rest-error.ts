/**
 * The text of a failed call's error: the app's own replies carry `{ error: 'text' }`, ServiceNow's REST errors
 * `{ error: { message, detail } }`; anything else reads as the HTTP status.
 */
export function restErrorMessage(error: unknown, status: number): string {
    if (typeof error === 'string' && error) return error
    if (error && typeof error === 'object') {
        const { message, detail } = error as { message?: unknown; detail?: unknown }
        if (typeof message === 'string' && message) return typeof detail === 'string' && detail ? `${message}: ${detail}` : message
    }
    return `HTTP ${status}`
}
