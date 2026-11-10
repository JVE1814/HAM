import { describe, expect, it } from 'vitest'
import { encodeCode128 } from './code128'

describe('encodeCode128', () => {
    it('encodes with start code B, checksum and stop pattern', () => {
        // Hand-computed: 104 + 48*1 + 42*2 + 42*3 + 17*4 + 18*5 + 19*6 + 35*7 = 879; 879 mod 103 = 55.
        const bars = encodeCode128('PJJ123C')
        expect(bars.startsWith('11010010000')).toBe(true) // Start B
        expect(bars.endsWith('1100011101011')).toBe(true) // Stop
        expect(bars.length).toBe(11 * (1 + 7 + 1) + 13)
        expect(bars.slice(-24, -13)).toBe('11101000110') // value 55 (checksum)
    })

    it("puts each character's own bars between the start and the checksum, in the order written", () => {
        // From the Code 128 table: Start B is value 104, A is 33, B is 34; the checksum is (104 + 33*1 + 34*2) mod 103 = 102.
        const startB = '11010010000'
        const a = '10100011000'
        const b = '10001011000'
        const value102 = '11110101110'
        expect(encodeCode128('AB')).toBe(`${startB}${a}${b}${value102}1100011101011`)
    })

    it('rejects characters outside printable ASCII', () => {
        expect(() => encodeCode128('é')).toThrow(/printable ASCII/)
    })
})
