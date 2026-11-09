import { describe, expect, it } from 'vitest'
import { formatProviderTag, isProviderTag, nextFreeSequence } from './provider-tag'

describe('provider tags', () => {
    it('formats a zero-padded tag from the next sequence number', () => {
        expect(formatProviderTag('NAAS', 42, 7)).toBe('NAAS-0000042')
    })

    it('recognises tags in that format', () => {
        expect(isProviderTag('NAAS-0000042', 'NAAS')).toBe(true)
        expect(isProviderTag('FOC1234X', 'NAAS')).toBe(false)
    })

    it.each(['NaaS-EU', 'NAAS.EU', 'NAAS_EU', 'A+B', 'N(A)S', '[NAAS]', '^NAAS$', 'NA|AS', 'NA*S?', 'N{2}', 'N\\S', 'N/S'])(
        'recognises the tag it formats with the prefix %s',
        (prefix) => {
            expect(isProviderTag(formatProviderTag(prefix, 42, 7), prefix)).toBe(true)
        },
    )

    it('matches a prefix with punctuation literally', () => {
        expect(isProviderTag('NaaSEU-0000042', 'NaaS-EU')).toBe(false)
        expect(isProviderTag('NAASXEU-0000042', 'NAAS.EU')).toBe(false)
        expect(isProviderTag('NA-0000042', 'NA|AS')).toBe(false)
        expect(isProviderTag('NAAAS-0000042', 'NA+S')).toBe(false)
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
