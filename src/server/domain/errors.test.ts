import { describe, expect, it } from 'vitest'
import { messageOf } from './errors'

describe('messageOf', () => {
    it("gives an Error's message and anything else as text", () => {
        expect(messageOf(new Error('insert refused'))).toBe('insert refused')
        expect(messageOf('deadlock')).toBe('deadlock')
        expect(messageOf(undefined)).toBe('undefined')
    })
})
