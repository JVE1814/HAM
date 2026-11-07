import { describe, expect, it } from 'vitest'
import { placementProblem, rackElevation } from './rack'

const placed = [
    { assetId: 'sw1', ruStart: 40, height: 1, face: 'front' as const },
    { assetId: 'fw1', ruStart: 30, height: 2, face: 'front' as const },
]

describe('placementProblem', () => {
    it('accepts a free slot inside the rack', () => {
        expect(placementProblem(42, placed, { assetId: 'new', ruStart: 35, height: 2, face: 'front' })).toBeNull()
    })

    it('rejects slots outside the rack or overlapping another device on the same face', () => {
        expect(placementProblem(42, placed, { assetId: 'new', ruStart: 42, height: 2, face: 'front' })).toBe('Rack units 42-43 do not fit in a 42U rack')
        expect(placementProblem(42, placed, { assetId: 'new', ruStart: 31, height: 1, face: 'front' })).toBe('Rack unit 31 is taken by fw1')
        expect(placementProblem(42, placed, { assetId: 'new', ruStart: 31, height: 1, face: 'rear' })).toBeNull()
    })

    it('lets a device keep its own slot', () => {
        expect(placementProblem(42, placed, { assetId: 'fw1', ruStart: 30, height: 2, face: 'front' })).toBeNull()
    })
})

describe('rackElevation', () => {
    it('lists units top-down with each device once at its top unit', () => {
        const rows = rackElevation(4, [{ assetId: 'a', ruStart: 2, height: 2, face: 'front' }], 'front')
        expect(rows).toEqual([
            { unit: 4, assetId: null, span: 1 },
            { unit: 3, assetId: 'a', span: 2 },
            { unit: 1, assetId: null, span: 1 },
        ])
    })
})
