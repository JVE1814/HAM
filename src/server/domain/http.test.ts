import { describe, expect, it } from 'vitest'
import { errorText, isSuccess } from './http'

describe('isSuccess', () => {
    it('accepts 2xx only', () => {
        expect([200, 202, 299].map(isSuccess)).toEqual([true, true, true])
        expect([0, 199, 300, 404].map(isSuccess)).toEqual([false, false, false, false])
    })
})

describe('errorText', () => {
    it('reads the first error in the common shapes', () => {
        expect(errorText(400, '{"errors":["Already claimed"]}')).toBe('HTTP 400: Already claimed')
        expect(errorText(400, '{"errors":[{"message":"Invalid postal code"}]}')).toBe('HTTP 400: Invalid postal code')
        expect(errorText(403, '{"message":"Forbidden"}')).toBe('HTTP 403: Forbidden')
        expect(errorText(500, '{"detail":"boom"}')).toBe('HTTP 500: boom')
        expect(errorText(400, '{"error":"invalid_request","error_description":"Device testSN doesn\'t exist in this account"}')).toBe(
            "HTTP 400: Device testSN doesn't exist in this account",
        )
        expect(errorText(400, '{"error":"invalid_grant"}')).toBe('HTTP 400: invalid_grant')
        expect(errorText(502, 'not json')).toBe('HTTP 502')
    })
})
