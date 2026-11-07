import { describe, expect, it } from 'vitest'
import { appendTo } from './collections'

describe('appendTo', () => {
    it('starts a list for a new key and appends to an existing one in order', () => {
        const lists = new Map<string, number[]>()
        appendTo(lists, 'a', 1)
        appendTo(lists, 'b', 2)
        appendTo(lists, 'a', 3)
        expect([...lists]).toEqual([
            ['a', [1, 3]],
            ['b', [2]],
        ])
    })
})
