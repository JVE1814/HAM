import { describe, expect, it } from 'vitest'
import { preflightReport } from './preflight'

describe('preflightReport', () => {
    it('passes when every required table and role exists', () => {
        const report = preflightReport({ tableExists: () => true, roleExists: () => true })
        expect(report).toEqual({ missing: [], summary: 'All prerequisites present' })
    })

    it('names each missing table with the plugin that provides it, and each missing role', () => {
        const report = preflightReport({
            tableExists: (t) => t !== 'wm_order',
            roleExists: (r) => r !== 'procurement_user',
        })
        expect(report.missing).toEqual(['table wm_order (Field Service Management)', 'role procurement_user'])
        expect(report.summary).toBe('2 prerequisite(s) missing')
    })
})
