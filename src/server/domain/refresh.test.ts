import { describe, expect, it } from 'vitest'
import { refreshWaves, replacementModel } from './refresh'

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

    it('finds nothing when the customer catalog has no sellable model of that class', () => {
        expect(replacementModel({ modelId: 'isr4331', deviceClass: 'router' }, catalog, lifecycle, '2026-11-07')).toBeNull()
    })
})
