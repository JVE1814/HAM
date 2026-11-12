import { field, isJsonObject, text } from '../json.ts'

/**
 * FortiCloud APIs answer HTTP 200 with an envelope whose status 0 means success; anything else is an
 * API error described by message or error. Returns that error, or null on success. A body that is not
 * a JSON object (unparsed, null, an array or a scalar) carries no envelope and is an error, not status 0.
 */
export function fortiCloudError(json: unknown): string | null {
    if (!isJsonObject(json)) return 'response is not a JSON object'
    const status = Number(field(json, 'status') ?? 0)
    if (status === 0) return null
    return text(field(json, 'message')) || text(field(json, 'error')) || `status ${text(field(json, 'status'))}`
}
