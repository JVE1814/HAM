import { describe, expect, it } from 'vitest'
import { parseJson } from '../json'
import { fortiCloudError } from './forticloud'

describe('fortiCloudError', () => {
    it('is null for status 0 (or no status) and the message or error otherwise', () => {
        expect(fortiCloudError({ status: 0, assets: [] })).toBeNull()
        expect(fortiCloudError({ assets: [] })).toBeNull()
        expect(fortiCloudError({ status: 1, message: 'Unit not found in this account' })).toBe('Unit not found in this account')
        expect(fortiCloudError({ status: -1, message: '', error: 'Invalid serial number' })).toBe('Invalid serial number')
        expect(fortiCloudError({ status: 2 })).toBe('status 2')
    })

    it('is an error for a body that is not a JSON object (no envelope to read a status from)', () => {
        for (const json of [parseJson('<html>Service unavailable</html>'), parseJson(''), null, [], 'ok', 0]) {
            expect(fortiCloudError(json)).toBe('response is not a JSON object')
        }
    })
})
