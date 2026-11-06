import { describe, expect, it } from 'vitest'
import { checkJobWindow } from './scheduling'

const change = { start: 1_000, end: 5_000 }

describe('checkJobWindow', () => {
    it('accepts on-site work inside the change window and the site maintenance window', () => {
        expect(checkJobWindow({ jobStart: 2_000, jobEnd: 3_000, change, inMaintenanceWindow: true })).toEqual({ ok: true })
    })

    it('rejects work outside the change window', () => {
        expect(checkJobWindow({ jobStart: 500, jobEnd: 3_000, change, inMaintenanceWindow: true })).toEqual({
            ok: false,
            reason: 'The work must be scheduled inside the change window',
        })
    })

    it('rejects work outside the site maintenance window', () => {
        expect(checkJobWindow({ jobStart: 2_000, jobEnd: 3_000, change, inMaintenanceWindow: false })).toEqual({
            ok: false,
            reason: "The work must be scheduled inside the site's maintenance window",
        })
    })

    it('only checks the change window once the change is scheduled', () => {
        expect(checkJobWindow({ jobStart: 2_000, jobEnd: 3_000, change: undefined, inMaintenanceWindow: true })).toEqual({ ok: true })
    })

    it('rejects a job that ends before it starts', () => {
        expect(checkJobWindow({ jobStart: 3_000, jobEnd: 2_000, change, inMaintenanceWindow: true }).ok).toBe(false)
    })
})
