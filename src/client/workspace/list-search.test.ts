import { describe, expect, it } from 'vitest'
import { PAGE_SIZE, parseListSearch, searchOf, viewOf, type ListSearch } from './list-search'

describe('parseListSearch', () => {
    it('keeps a page past the first', () => {
        expect(parseListSearch({ page: 2 })).toEqual({ page: 2 })
        expect(parseListSearch({ page: '3' })).toEqual({ page: 3 })
    })

    it('leaves out the first page and anything that is no page', () => {
        for (const search of [{ page: 1 }, { page: 0 }, { page: -2 }, { page: 1.5 }, { page: 'x' }, {}]) expect(parseListSearch(search)).toEqual({})
    })

    it('keeps a sort on a field, descending with a leading -', () => {
        for (const sort of ['ends', '-ends', 'agreement.currency']) expect(parseListSearch({ sort })).toEqual({ sort })
    })

    it('drops a sort that is no field name', () => {
        for (const sort of ['ends^NQactive=true', '--ends', 'a b', '', 5]) expect(parseListSearch({ sort })).toEqual({})
    })

    it('keeps the text searched for, a number as text', () => {
        expect(parseListSearch({ q: 'cisco' })).toEqual({ q: 'cisco' })
        expect(parseListSearch({ q: 42 })).toEqual({ q: '42' })
        for (const q of ['', {}, null]) expect(parseListSearch({ q })).toEqual({})
    })
})

describe('viewOf', () => {
    it("opens the first page in the list's own order with no search", () => {
        expect(viewOf({})).toEqual({ page: 0, size: PAGE_SIZE, sort: null, search: '' })
    })

    it('counts pages from 0 where the address counts from 1', () => {
        expect(viewOf({ page: 3 }).page).toBe(2)
    })

    it("reads the sort's field and direction", () => {
        expect(viewOf({ sort: '-ends' }).sort).toEqual({ id: 'ends', desc: true })
        expect(viewOf({ sort: 'ends' }).sort).toEqual({ id: 'ends', desc: false })
    })
})

describe('searchOf', () => {
    it('leaves each part out at its default', () => {
        expect(searchOf(viewOf({}))).toEqual({})
    })

    it('writes the view back as the address had it', () => {
        const searches: ListSearch[] = [{ page: 2 }, { sort: '-ends' }, { sort: 'agreement.currency', q: 'cisco' }, { page: 4, sort: 'ends', q: 'x' }]
        for (const search of searches) expect(searchOf(viewOf(search))).toEqual(search)
    })
})
