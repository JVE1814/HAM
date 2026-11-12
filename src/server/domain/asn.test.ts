import { describe, expect, it } from 'vitest'
import { asnRowProblem } from './asn'

const row = { serial: 'foc1 ', pid: 'C9300-48P-E', poNumber: 'PO1' }

describe('asnRowProblem', () => {
    it('accepts a row with a serial, a PID and a purchase order whose serial no Asset has', () => {
        expect(asnRowProblem(row, false)).toBeNull()
    })

    it('refuses a row missing its serial, its PID or its purchase order', () => {
        expect(asnRowProblem({ ...row, serial: '  ' }, false)).toBe('serial is required')
        expect(asnRowProblem({ ...row, pid: ' ' }, false)).toBe('PID is required')
        expect(asnRowProblem({ ...row, poNumber: '' }, false)).toBe('purchase order is required')
    })

    it('refuses a serial an Asset already has, naming it as stored', () => {
        expect(asnRowProblem(row, true)).toBe('serial FOC1 already exists')
    })
})
