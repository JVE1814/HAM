import { describe, expect, it } from 'vitest'
import { appendTo, firstBest } from './collections'

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

describe('firstBest', () => {
    const byScore = (a: { score: number }, b: { score: number }) => a.score - b.score

    it('gives the item ranked highest, the first of those tied', () => {
        const items = [{ id: 'a', score: 1 }, { id: 'b', score: 3 }, { id: 'c', score: 3 }, { id: 'd', score: 2 }]
        expect(firstBest(items, byScore)?.id).toBe('b')
    })

    it('gives nothing for no items', () => {
        expect(firstBest([], byScore)).toBeUndefined()
    })
})
