import { describe, expect, it } from 'vitest'
import { receiveSerialLockName, validateAsnRows } from './asn'

describe('validateAsnRows', () => {
    it('accepts rows with a serial, a PID and a purchase order', () => {
        expect(validateAsnRows([{ serial: 'FOC1', pid: 'C9300-48P-E', poNumber: 'PO1' }], new Set())).toEqual([{ row: 0, ok: true }])
    })

    it('rejects missing fields, serials repeated in the file and serials already known', () => {
        const result = validateAsnRows(
            [
                { serial: '', pid: 'X', poNumber: 'PO1' },
                { serial: 'FOC2', pid: '', poNumber: 'PO1' },
                { serial: 'foc3 ', pid: 'X', poNumber: 'PO1' },
                { serial: 'FOC3', pid: 'X', poNumber: 'PO1' },
                { serial: 'FOC9', pid: 'X', poNumber: 'PO1' },
            ],
            new Set(['FOC9']),
        )
        expect(result).toEqual([
            { row: 0, ok: false, reason: 'serial is required' },
            { row: 1, ok: false, reason: 'PID is required' },
            { row: 2, ok: true },
            { row: 3, ok: false, reason: 'serial FOC3 appears more than once in this ASN' },
            { row: 4, ok: false, reason: 'serial FOC9 already exists' },
        ])
    })
})

describe('receiveSerialLockName', () => {
    it('names one lock for a serial however it is typed, so a scan and an ASN row take the same one', () => {
        expect(receiveSerialLockName(' foc123 ')).toBe('receive_serial_FOC123')
        expect(receiveSerialLockName('FOC123')).toBe(receiveSerialLockName('foc123'))
    })

    it('fits the Job lock name (100 characters)', () => {
        const name = receiveSerialLockName('X'.repeat(100))
        expect(name).toHaveLength(100)
        expect(name.startsWith('receive_serial_XXX')).toBe(true)
    })
})
