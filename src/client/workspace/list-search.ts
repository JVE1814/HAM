import type { ListView } from '../lib/sn'

export const PAGE_SIZE = 50

/** A list's view in its address: `?page=2&sort=-ends&q=cisco`, each left out at its default. */
export interface ListSearch {
    page?: number
    /** A field, `-` first for descending. */
    sort?: string
    q?: string
}

export function parseListSearch(search: Record<string, unknown>): ListSearch {
    const page = Number(search.page)
    const sort = typeof search.sort === 'string' && /^-?[\w.]+$/.test(search.sort) ? search.sort : undefined
    const q = typeof search.q === 'string' || typeof search.q === 'number' ? String(search.q) : ''
    return { ...(Number.isInteger(page) && page > 1 ? { page } : {}), ...(sort ? { sort } : {}), ...(q ? { q } : {}) }
}

export function viewOf({ page, sort, q }: ListSearch): ListView {
    return {
        page: (page ?? 1) - 1,
        size: PAGE_SIZE,
        sort: sort ? { id: sort.replace(/^-/, ''), desc: sort.startsWith('-') } : null,
        search: q ?? '',
    }
}

export function searchOf(view: ListView): ListSearch {
    return {
        ...(view.page > 0 ? { page: view.page + 1 } : {}),
        ...(view.sort ? { sort: `${view.sort.desc ? '-' : ''}${view.sort.id}` } : {}),
        ...(view.search ? { q: view.search } : {}),
    }
}
