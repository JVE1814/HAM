import { describe, expect, it } from 'vitest'
import { normalizeSerial } from './serials'

describe('normalizeSerial', () => {
    it('trims and upper-cases, so a scan matches the stored serial however it was typed', () => {
        expect(normalizeSerial('  fcw2345l0ab \n')).toBe('FCW2345L0AB')
        expect(normalizeSerial('   ')).toBe('')
    })
})
