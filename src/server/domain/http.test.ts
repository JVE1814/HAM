import { describe, expect, it } from 'vitest'
import { failureText, isSuccess } from './http'

describe('isSuccess', () => {
    it('accepts 2xx only', () => {
        expect([200, 202, 299].map(isSuccess)).toEqual([true, true, true])
        expect([0, 199, 300, 404].map(isSuccess)).toEqual([false, false, false, false])
    })
})

describe('failureText', () => {
    it('reads the first error of an answer in the common shapes', () => {
        expect(failureText({ status: 400, body: '{"errors":["Already claimed"]}' })).toBe('HTTP 400: Already claimed')
        expect(failureText({ status: 400, body: '{"errors":[{"message":"Invalid postal code"}]}' })).toBe('HTTP 400: Invalid postal code')
        expect(failureText({ status: 403, body: '{"message":"Forbidden"}' })).toBe('HTTP 403: Forbidden')
        expect(failureText({ status: 500, body: '{"detail":"boom"}' })).toBe('HTTP 500: boom')
        expect(failureText({ status: 400, body: '{"error":"invalid_request","error_description":"Device testSN doesn\'t exist in this account"}' })).toBe(
            "HTTP 400: Device testSN doesn't exist in this account",
        )
        expect(failureText({ status: 400, body: '{"error":"invalid_grant"}' })).toBe('HTTP 400: invalid_grant')
        expect(failureText({ status: 502, body: 'not json' })).toBe('HTTP 502')
    })

    it('names the reason the transport gave when no answer came (status 0), never "HTTP 0"', () => {
        expect(failureText({ status: 0, body: '', error: 'java.net.SocketTimeoutException: Read timed out' })).toBe(
            'no response: java.net.SocketTimeoutException: Read timed out',
        )
        expect(failureText({ status: 0, body: '' })).toBe('no response')
    })
})
