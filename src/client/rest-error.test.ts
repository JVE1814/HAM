import { describe, expect, it } from 'vitest'
import { restErrorMessage } from './rest-error'

describe('restErrorMessage', () => {
    it("reads the app's own error text and ServiceNow's error object", () => {
        expect(restErrorMessage('Choose one of your stockrooms', 400)).toBe('Choose one of your stockrooms')
        expect(restErrorMessage({ message: 'User Not Authenticated', detail: 'Required to provide Auth information' }, 401)).toBe(
            'User Not Authenticated: Required to provide Auth information',
        )
        expect(restErrorMessage({ message: 'Not found' }, 404)).toBe('Not found')
    })

    it('falls back to the HTTP status for anything else', () => {
        expect(restErrorMessage(undefined, 500)).toBe('HTTP 500')
        expect(restErrorMessage('', 502)).toBe('HTTP 502')
        expect(restErrorMessage({ code: 7 }, 503)).toBe('HTTP 503')
    })
})
