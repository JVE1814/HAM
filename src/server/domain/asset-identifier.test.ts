import { describe, expect, it } from 'vitest'
import { ambiguousIdentifier, fieldMatch, IDENTIFIER_FIELDS, IDENTIFIER_READ_LIMIT } from './asset-identifier.ts'

describe('IDENTIFIER_FIELDS', () => {
    it('looks for an identifier as a serial number, then a Provider tag, then a Customer tag', () => {
        expect(IDENTIFIER_FIELDS.map((field) => field.field)).toEqual(['serial_number', 'asset_tag', 'x_daas_ham_customer_tag'])
    })

    it('reads two Assets per field, enough to tell an identifier is ambiguous', () => {
        expect(IDENTIFIER_READ_LIMIT).toBe(2)
    })
})

describe('fieldMatch', () => {
    it('finds nothing when no Asset carries the identifier in the field, so the next field is tried', () => {
        expect(fieldMatch([])).toEqual({ kind: 'none' })
    })

    it('names the one Asset carrying it, fleet or not', () => {
        expect(fieldMatch([true])).toEqual({ kind: 'one', index: 0 })
        expect(fieldMatch([false])).toEqual({ kind: 'one', index: 0 })
    })

    it('refuses an identifier two fleet assets carry, as two Customers tagging a switch SW-01', () => {
        expect(fieldMatch([true, true])).toEqual({ kind: 'ambiguous' })
    })

    it("chooses the fleet asset over the Provider IT's one carrying the same identifier (read fleet first)", () => {
        expect(fieldMatch([true, false])).toEqual({ kind: 'one', index: 0 })
    })

    it("refuses an identifier two of the Provider IT's Assets carry", () => {
        expect(fieldMatch([false, false])).toEqual({ kind: 'ambiguous' })
    })
})

describe('ambiguousIdentifier', () => {
    it('says which field is shared and which identifiers to use instead', () => {
        const [serial, , customerTag] = IDENTIFIER_FIELDS
        expect(ambiguousIdentifier('SW-01', customerTag)).toBe('More than one asset has Customer tag SW-01: use its serial number or Provider tag instead')
        expect(ambiguousIdentifier('FOC1', serial)).toBe('More than one asset has serial number FOC1: use its Provider tag or Customer tag instead')
    })
})
