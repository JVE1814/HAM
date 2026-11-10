import { describe, expect, it } from 'vitest'
import { dueAfter, firstCandidatesDue, refreshWaves, replacementModel, type DueKey, type DueRow, type RefreshCandidate } from './refresh'

describe('refreshWaves', () => {
    it('groups due assets by agreement and site', () => {
        const waves = refreshWaves([
            { assetId: 'a1', agreementId: 'agr', customerId: 'acme', siteId: 'hq', modelId: 'm1', deviceClass: 'switch' },
            { assetId: 'a2', agreementId: 'agr', customerId: 'acme', siteId: 'store', modelId: 'm1', deviceClass: 'switch' },
            { assetId: 'a3', agreementId: 'agr', customerId: 'acme', siteId: 'hq', modelId: 'm2', deviceClass: 'ap' },
        ])
        expect(waves).toEqual([
            { agreementId: 'agr', customerId: 'acme', siteId: 'hq', assets: [expect.objectContaining({ assetId: 'a1' }), expect.objectContaining({ assetId: 'a3' })] },
            { agreementId: 'agr', customerId: 'acme', siteId: 'store', assets: [expect.objectContaining({ assetId: 'a2' })] },
        ])
    })
})

describe('replacementModel', () => {
    const catalog = [
        { modelId: 'c9300', deviceClass: 'switch' },
        { modelId: 'c9300x', deviceClass: 'switch' },
        { modelId: 'mr57', deviceClass: 'ap' },
    ]
    const lifecycle = new Map([
        ['c9300', { endOfSale: '2026-01-31', endOfSupport: '2031-01-31' }],
        ['c9300x', { endOfSale: '2030-01-31', endOfSupport: '2035-01-31' }],
        ['mr57', {}],
    ])

    it('keeps the same model while it is catalogued and still sold', () => {
        expect(replacementModel({ modelId: 'mr57', deviceClass: 'ap' }, catalog, lifecycle, '2026-11-07')).toBe('mr57')
    })

    it('moves to the catalogued model of the same class with the longest support once the old one is no longer sold', () => {
        expect(replacementModel({ modelId: 'c9300', deviceClass: 'switch' }, catalog, lifecycle, '2026-11-07')).toBe('c9300x')
    })

    it('prefers a model with a known end of support over one with none on record (not synced yet)', () => {
        const withUnsynced = [{ modelId: 'c9200', deviceClass: 'switch' }, ...catalog]
        const lifecycleOf = new Map([...lifecycle, ['c9200', {}]])
        expect(replacementModel({ modelId: 'c9300', deviceClass: 'switch' }, withUnsynced, lifecycleOf, '2026-11-07')).toBe('c9300x')
        // No lifecycle entry at all reads the same.
        expect(replacementModel({ modelId: 'c9300', deviceClass: 'switch' }, withUnsynced, lifecycle, '2026-11-07')).toBe('c9300x')
    })

    it('takes a model without a known end of support only when no other sellable one is catalogued, in catalog order', () => {
        const unknowns = [
            { modelId: 'c9300', deviceClass: 'switch' },
            { modelId: 'c9200', deviceClass: 'switch' },
            { modelId: 'c9500', deviceClass: 'switch' },
        ]
        expect(replacementModel({ modelId: 'c9300', deviceClass: 'switch' }, unknowns, lifecycle, '2026-11-07')).toBe('c9200')
    })

    it('finds nothing when the customer catalog has no sellable model of that class', () => {
        expect(replacementModel({ modelId: 'isr4331', deviceClass: 'router' }, catalog, lifecycle, '2026-11-07')).toBeNull()
    })
})

describe('dueAfter', () => {
    it('reads from the start without a key', () => {
        expect(dueAfter('install_status=1^x_daas_ham_fleet=true', null)).toBe('install_status=1^x_daas_ham_fleet=true')
    })

    it('narrows every clause to a later due date, or the same one and a later sys_id', () => {
        const query = 'install_status=1^x_daas_ham_fleet=true^NQinstall_status=2^x_daas_ham_fleet=true'
        expect(dueAfter(query, { due: '2026-12-01', id: 'abc' }).split('^NQ')).toEqual([
            'install_status=1^x_daas_ham_fleet=true^x_daas_ham_refresh_due>2026-12-01',
            'install_status=2^x_daas_ham_fleet=true^x_daas_ham_refresh_due>2026-12-01',
            'install_status=1^x_daas_ham_fleet=true^x_daas_ham_refresh_due=2026-12-01^sys_id>abc',
            'install_status=2^x_daas_ham_fleet=true^x_daas_ham_refresh_due=2026-12-01^sys_id>abc',
        ])
    })
})

describe('firstCandidatesDue', () => {
    /** Assets due in (due, sys_id) order; the first `onOrder` of them are already on open replacing lines. */
    function assetsDue(count: number, onOrder: number): Array<{ key: DueKey; onOrder: boolean }> {
        return Array.from({ length: count }, (_, i) => ({
            key: { due: `2026-12-${String(1 + Math.floor(i / 10)).padStart(2, '0')}`, id: `a${String(i).padStart(4, '0')}` },
            onOrder: i < onOrder,
        }))
    }

    const candidate = (id: string): RefreshCandidate => ({
        assetId: id,
        agreementId: 'agr',
        customerId: 'acme',
        siteId: 'hq',
        modelId: 'm1',
        deviceClass: 'switch',
    })

    /** A keyset read over `assets`, as the query dueAfter builds; counts the pages read. */
    function reader(assets: ReturnType<typeof assetsDue>) {
        const pages: number[] = []
        const readPage = (after: DueKey | null, size: number): DueRow[] => {
            const later = assets.filter(({ key }) => !after || key.due > after.due || (key.due === after.due && key.id > after.id))
            const page = later.slice(0, size).map(({ key, onOrder }) => ({ key, candidate: onOrder ? null : candidate(key.id) }))
            pages.push(page.length)
            return page
        }
        return { readPage, pages }
    }

    it('reads past the earliest due that wait on open Orders, so the later ones still come', () => {
        const { readPage, pages } = reader(assetsDue(130, 110))
        const found = firstCandidatesDue(readPage, 50, () => false)
        expect(found.map((c) => c.assetId)).toEqual(assetsDue(130, 0).slice(110).map(({ key }) => key.id))
        expect(pages).toEqual([50, 50, 30])
    })

    it('stops at the limit, earliest due first', () => {
        const { readPage, pages } = reader(assetsDue(130, 30))
        const found = firstCandidatesDue(readPage, 50, () => false)
        expect(found).toHaveLength(50)
        expect(found[0].assetId).toBe('a0030')
        expect(found[49].assetId).toBe('a0079')
        expect(pages).toEqual([50, 50])
    })

    it('stops after a page once out of time, with what it found', () => {
        const { readPage, pages } = reader(assetsDue(130, 60))
        expect(firstCandidatesDue(readPage, 50, () => true)).toEqual([])
        expect(pages).toEqual([50])
    })
})
