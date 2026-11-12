import { describe, expect, it } from 'vitest'
import { MAX_LISTED_DEVICES, sentDeviceList, uniqueIds } from './customer-requests'

describe('sentDeviceList', () => {
    it('gives the list as sent, up to the most a request may list', () => {
        expect(sentDeviceList(['a1', 'a2'])).toEqual({ list: ['a1', 'a2'] })
        expect(sentDeviceList(Array(MAX_LISTED_DEVICES).fill('a1'))).toMatchObject({ list: { length: MAX_LISTED_DEVICES } })
    })

    it('refuses a longer list', () => {
        expect(sentDeviceList(Array(MAX_LISTED_DEVICES + 1).fill('a1'))).toEqual({ error: 'At most 5000 devices per request' })
    })

    it('reads anything but an array as an empty list', () => {
        for (const sent of [undefined, null, 'a1', { length: 9000 }]) expect(sentDeviceList(sent)).toEqual({ list: [] })
    })
})

describe('uniqueIds', () => {
    it('names each id once, in the order first named', () => {
        expect(uniqueIds(['a2', 'a1', 'a2', 'a1', 'a3'])).toEqual(['a2', 'a1', 'a3'])
    })

    it('reads each entry as text', () => {
        expect(uniqueIds([7, '7', null])).toEqual(['7', 'null'])
    })
})
