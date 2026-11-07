import { field, text } from '../json'

/**
 * FortiCloud APIs answer HTTP 200 with an envelope whose status 0 means success; anything else is an
 * API error described by message or error. Returns that error, or null on success.
 */
export function fortiCloudError(json: unknown): string | null {
    const status = Number(field(json, 'status') ?? 0)
    if (status === 0) return null
    return text(field(json, 'message')) || text(field(json, 'error')) || `status ${text(field(json, 'status'))}`
}
