import { describe, expect, it } from 'vitest'
import { chargedFeeQuery, openFeeQuery } from './fees'
import { recordMatches as matches } from '../test-support/encoded-query'
import type { SampleRecord } from '../test-support/stored-asset'

describe('fee identity', () => {
    const sysId = (c: string) => c.repeat(32)
    const fee = { type: 'late_return' as const, assetId: sysId('a'), returnOrderId: sysId('r') }

    const charge = (fields: SampleRecord = {}) => ({ fee_type: 'late_return', asset: sysId('a'), return_order: sysId('r'), status: 'open', ...fields })

    it('counts every charge of the same type, Asset and Return order but a waived one', () => {
        expect(matches(chargedFeeQuery(fee), charge())).toBe(true)
        expect(matches(chargedFeeQuery(fee), charge({ status: 'billed' }))).toBe(true)
        expect(matches(chargedFeeQuery(fee), charge({ status: 'waived' }))).toBe(false)
    })

    it('finds open only the charges neither billed nor waived', () => {
        expect(matches(openFeeQuery(fee), charge())).toBe(true)
        expect(matches(openFeeQuery(fee), charge({ status: 'billed' }))).toBe(false)
        expect(matches(openFeeQuery(fee), charge({ status: 'waived' }))).toBe(false)
    })

    it.each([
        ['charged', chargedFeeQuery],
        ['open', openFeeQuery],
    ])('finds no %s charge of another type, Asset or Return order', (_, query) => {
        expect(matches(query(fee), charge({ fee_type: 'lost' }))).toBe(false)
        expect(matches(query(fee), charge({ asset: sysId('b') }))).toBe(false)
        expect(matches(query(fee), charge({ return_order: sysId('s') }))).toBe(false)
    })
})
