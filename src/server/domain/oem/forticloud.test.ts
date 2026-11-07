import { describe, expect, it } from 'vitest'
import { fortiCloudError } from './forticloud'

describe('fortiCloudError', () => {
    it('is null for status 0 (or no status) and the message or error otherwise', () => {
        expect(fortiCloudError({ status: 0, assets: [] })).toBeNull()
        expect(fortiCloudError({ assets: [] })).toBeNull()
        expect(fortiCloudError({ status: 1, message: 'Unit not found in this account' })).toBe('Unit not found in this account')
        expect(fortiCloudError({ status: -1, message: '', error: 'Invalid serial number' })).toBe('Invalid serial number')
        expect(fortiCloudError({ status: 2 })).toBe('status 2')
    })
})
