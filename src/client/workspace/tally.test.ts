import { describe, expect, it } from 'vitest'
import { tint, topGroups } from './tally'

const tally = [
    { key: 'a', label: 'A', count: 9 },
    { key: 'b', label: 'B', count: 5 },
    { key: 'c', label: 'C', count: 2 },
    { key: 'd', label: 'D', count: 1 },
]

describe('topGroups', () => {
    it('shows the top groups and adds up the rest as Others', () => {
        expect(topGroups(tally, 2, true)).toEqual([tally[0], tally[1], { key: '', label: 'Others', count: 3 }])
    })

    it('drops the rest when Others is not asked for', () => {
        expect(topGroups(tally, 2, false)).toEqual([tally[0], tally[1]])
    })

    it('adds no Others when nothing is left over', () => {
        expect(topGroups(tally, 4, true)).toEqual(tally)
        expect(topGroups(tally, 10, true)).toEqual(tally)
        expect(topGroups([], 3, true)).toEqual([])
    })
})

describe('tint', () => {
    it('tints nothing for no amount or an empty column', () => {
        expect(tint(0, 100)).toBe('')
        expect(tint(50, 0)).toBe('')
    })

    it('tints darker the nearer an amount is to the largest', () => {
        expect(tint(10, 100)).toBe('bg-chart-1/10')
        expect(tint(50, 100)).toBe('bg-chart-1/35')
        expect(tint(100, 100)).toBe('bg-chart-1/70')
    })

    it('tints a negative amount red by its size', () => {
        expect(tint(-100, 100)).toBe('bg-destructive/70')
        expect(tint(-10, 100)).toBe('bg-destructive/10')
    })
})
