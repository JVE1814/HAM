import { describe, expect, it } from 'vitest'
import { formatProviderTag, isProviderTag } from './provider-tag'

describe('provider tags', () => {
    it('formats a zero-padded tag from the next sequence number', () => {
        expect(formatProviderTag('NAAS', 42, 7)).toBe('NAAS-0000042')
    })

    it('recognises tags in that format', () => {
        expect(isProviderTag('NAAS-0000042', 'NAAS')).toBe(true)
        expect(isProviderTag('FOC1234X', 'NAAS')).toBe(false)
    })
})
