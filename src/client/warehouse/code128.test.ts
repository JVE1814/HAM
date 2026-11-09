import { describe, expect, it } from 'vitest'
import { barsOf, encodeCode128 } from './code128'

describe('encodeCode128', () => {
    it('encodes with start code B, checksum and stop pattern', () => {
        // Hand-computed: 104 + 48*1 + 42*2 + 42*3 + 17*4 + 18*5 + 19*6 + 35*7 = 879; 879 mod 103 = 55.
        const bars = encodeCode128('PJJ123C')
        expect(bars.startsWith('11010010000')).toBe(true) // Start B
        expect(bars.endsWith('1100011101011')).toBe(true) // Stop
        expect(bars.length).toBe(11 * (1 + 7 + 1) + 13)
        expect(bars.slice(-24, -13)).toBe('11101000110') // value 55 (checksum)
    })

    it('rejects characters outside printable ASCII', () => {
        expect(() => encodeCode128('é')).toThrow(/printable ASCII/)
    })
})

describe('barsOf', () => {
    it('draws each run of bar modules as one bar', () => {
        expect(barsOf('1101100')).toEqual([
            { x: 0, width: 2 },
            { x: 3, width: 2 },
        ])
        expect(barsOf('0011100101')).toEqual([
            { x: 2, width: 3 },
            { x: 7, width: 1 },
            { x: 9, width: 1 },
        ])
        expect(barsOf('000')).toEqual([])
    })

    it('covers exactly the bar modules of an encoded tag', () => {
        const modules = encodeCode128('PJJ123C')
        const drawn = Array.from({ length: modules.length }, () => '0')
        for (const { x, width } of barsOf(modules)) for (let i = x; i < x + width; i++) drawn[i] = '1'
        expect(drawn.join('')).toBe(modules)
        // The stop pattern ends in a two-module bar, drawn as one shape.
        expect(barsOf(modules).at(-1)).toEqual({ x: modules.length - 2, width: 2 })
    })
})
