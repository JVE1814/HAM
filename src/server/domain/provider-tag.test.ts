import { describe, expect, it } from 'vitest'
import { formatProviderTag, nextFreeSequence } from './provider-tag'

describe('provider tags', () => {
    it('formats a zero-padded tag from the next sequence number', () => {
        expect(formatProviderTag('NAAS', 42, 7)).toBe('NAAS-0000042')
    })

})

describe('next free sequence', () => {
    it('issues the number after the counter when its tag is free', () => {
        expect(nextFreeSequence(0, () => false)).toBe(1)
        expect(nextFreeSequence(41, () => false)).toBe(42)
    })

    it('skips the numbers already on an Asset when a stale holder set the counter back', () => {
        // A read 0 and stalled past its lock; B and C issued 1 and 2; A's late write set the counter back to 1.
        const onAssets = new Set([1, 2])
        expect(nextFreeSequence(1, (sequence) => onAssets.has(sequence))).toBe(3)
    })
})
