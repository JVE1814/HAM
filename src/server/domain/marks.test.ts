import { describe, expect, it } from 'vitest'
import { createMarks } from './marks'

describe('createMarks', () => {
    it('marks an item only while its callback runs, and returns what the callback returns', () => {
        const marks = createMarks<object>()
        const record = {}
        const seen: boolean[] = []
        const result = marks.during(record, () => {
            seen.push(marks.has(record))
            return 'read'
        })
        expect(result).toBe('read')
        expect(seen).toEqual([true])
        expect(marks.has(record)).toBe(false)
    })

    it('unmarks the item when the callback throws, and lets the error through', () => {
        const marks = createMarks<object>()
        const record = {}
        expect(() =>
            marks.during(record, () => {
                throw new Error('query failed')
            }),
        ).toThrow('query failed')
        expect(marks.has(record)).toBe(false)
    })

    it('compares by identity: an equal-looking item, or another one read meanwhile, is not marked', () => {
        const marks = createMarks<object>()
        const record = { table: 'alm_hardware' }
        const other = { table: 'alm_hardware' }
        marks.during(record, () => {
            expect(marks.has(other)).toBe(false)
            marks.during(other, () => expect(marks.has(record) && marks.has(other)).toBe(true))
            expect(marks.has(other)).toBe(false)
        })
        expect(marks.has(record)).toBe(false)
    })

    it('keeps an item marked twice until the outermost callback ends, even when the inner one throws', () => {
        const marks = createMarks<object>()
        const record = {}
        marks.during(record, () => {
            expect(() =>
                marks.during(record, () => {
                    throw new Error('inner')
                }),
            ).toThrow('inner')
            expect(marks.has(record)).toBe(true)
        })
        expect(marks.has(record)).toBe(false)
    })
})
