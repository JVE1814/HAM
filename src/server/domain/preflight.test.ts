import { describe, expect, it } from 'vitest'
import { preflightReport } from './preflight'
import { PROPERTY } from './properties'
import { WEBHOOK_TOKEN_MIN_LENGTH } from './shipping'

const LONG_TOKEN = 'webhook-'.padEnd(WEBHOOK_TOKEN_MIN_LENGTH, 'x')
const present = { tableExists: () => true, roleExists: () => true }

describe('preflightReport', () => {
    it('passes when every required table and role exists', () => {
        const report = preflightReport({ ...present, webhookToken: () => LONG_TOKEN })
        expect(report).toEqual({ missing: [], problems: [], summary: 'All prerequisites present' })
    })

    it('names each missing table with the plugin that provides it, and each missing role', () => {
        const report = preflightReport({
            tableExists: (t) => t !== 'wm_order',
            roleExists: (r) => r !== 'procurement_user',
            webhookToken: () => LONG_TOKEN,
        })
        expect(report.missing).toEqual(['table wm_order (Field Service Management)', 'role procurement_user'])
        expect(report.summary).toBe('2 prerequisite(s) missing')
    })

    it('names the webhook token property, and never the token, while it is shorter than the minimum', () => {
        const short = LONG_TOKEN.slice(0, WEBHOOK_TOKEN_MIN_LENGTH - 1)
        const report = preflightReport({ ...present, webhookToken: () => short })
        expect(report.missing).toEqual([])
        expect(report.problems).toEqual([
            expect.stringContaining(`${PROPERTY.shippingWebhookToken.name} is shorter than ${WEBHOOK_TOKEN_MIN_LENGTH} characters`),
        ])
        expect(report.problems.join('\n')).not.toContain(short)
        expect(report.summary).toBe('1 setting(s) to correct')
    })

    it('finds no problem in an empty webhook token, which refuses every webhook by design', () => {
        expect(preflightReport({ ...present, webhookToken: () => '' }).problems).toEqual([])
    })

    it('counts missing prerequisites and settings to correct together', () => {
        const report = preflightReport({ tableExists: (t) => t !== 'wm_order', roleExists: () => true, webhookToken: () => 'short' })
        expect(report.summary).toBe('1 prerequisite(s) missing, 1 setting(s) to correct')
    })
})
