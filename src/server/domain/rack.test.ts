import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { overlaps, PLACEMENT_FIELDS, placementProblem, powerBudget, rackElevation } from './rack'

const rack42 = { units: 42, powerCapacityW: 0 }
const placed = [
    { assetId: 'sw1', ruStart: 40, height: 1, face: 'front' as const, powerW: 350 },
    { assetId: 'fw1', ruStart: 30, height: 2, face: 'front' as const, powerW: 250 },
]

describe('placementProblem', () => {
    it('accepts a free slot inside the rack', () => {
        expect(placementProblem(rack42, placed, { assetId: 'new', ruStart: 35, height: 2, face: 'front' })).toBeNull()
    })

    it('rejects slots outside the rack or overlapping another device on the same face', () => {
        expect(placementProblem(rack42, placed, { assetId: 'new', ruStart: 42, height: 2, face: 'front' })).toBe('Rack units 42-43 do not fit in a 42U rack')
        expect(placementProblem(rack42, placed, { assetId: 'new', ruStart: 31, height: 1, face: 'front' })).toBe('Rack unit 31 is taken by fw1')
        expect(placementProblem(rack42, placed, { assetId: 'new', ruStart: 31, height: 1, face: 'rear' })).toBeNull()
    })

    it('lets a device keep its own slot', () => {
        expect(placementProblem(rack42, placed, { assetId: 'fw1', ruStart: 30, height: 2, face: 'front' })).toBeNull()
    })
})

describe('placementProblem with a power budget', () => {
    const budgeted = { units: 42, powerCapacityW: 1000 }

    it('accepts a device that fits the remaining power', () => {
        expect(placementProblem(budgeted, placed, { assetId: 'new', ruStart: 10, height: 1, face: 'rear', powerW: 400 })).toBeNull()
    })

    it('refuses a device that would exceed it, counting both faces', () => {
        expect(placementProblem(budgeted, placed, { assetId: 'new', ruStart: 10, height: 1, face: 'rear', powerW: 401 })).toBe(
            "The rack's power budget would be exceeded: 1001 W of 1000 W",
        )
    })

    it('does not count a device twice when it is re-placed (its old placement is excluded)', () => {
        const full = { units: 42, powerCapacityW: 600 }
        expect(placementProblem(full, placed, { assetId: 'sw1', ruStart: 20, height: 1, face: 'front', powerW: 350 })).toBeNull()
    })
})

describe('placementProblem in a rack already over its power budget', () => {
    const overloaded = { units: 42, powerCapacityW: 500 }

    it('lets a device move within the rack', () => {
        expect(placementProblem(overloaded, placed, { assetId: 'sw1', ruStart: 20, height: 1, face: 'front', powerW: 350 }, 350)).toBeNull()
    })

    it('allows a swap to a lower-power Model', () => {
        expect(placementProblem(overloaded, placed, { assetId: 'sw1', ruStart: 40, height: 1, face: 'front', powerW: 300 }, 350)).toBeNull()
    })

    it('refuses a swap to a higher-power Model', () => {
        expect(placementProblem(overloaded, placed, { assetId: 'sw1', ruStart: 40, height: 1, face: 'front', powerW: 400 }, 350)).toBe(
            "The rack's power budget would be exceeded: 650 W of 500 W",
        )
    })

    it('refuses a device new to the rack', () => {
        expect(placementProblem(overloaded, placed, { assetId: 'new', ruStart: 10, height: 1, face: 'rear', powerW: 10 })).toBe(
            "The rack's power budget would be exceeded: 610 W of 500 W",
        )
    })
})

describe('powerBudget', () => {
    it('sums typical power against the capacity', () => {
        expect(powerBudget(1000, placed)).toEqual({ capacityW: 1000, usedW: 600, utilisation: 60 })
    })

    it('has no utilisation without a capacity', () => {
        expect(powerBudget(0, [...placed, { assetId: 'x', ruStart: 1, height: 1, face: 'front' }])).toEqual({ capacityW: 0, usedW: 600, utilisation: null })
    })
})

describe('overlaps', () => {
    it('finds nothing in a rack whose devices each have their own units', () => {
        expect(overlaps(placed)).toEqual([])
    })

    it('lets devices touch: one directly above or below another shares no unit', () => {
        const touching = [
            ...placed,
            { assetId: 'above', ruStart: 32, height: 1, face: 'front' as const },
            { assetId: 'below', ruStart: 28, height: 2, face: 'front' as const },
        ]
        expect(overlaps(touching)).toEqual([])
        expect(overlaps([...placed, { assetId: 'low', ruStart: 29, height: 2, face: 'front' }])).toEqual([
            { assetIds: ['fw1', 'low'], face: 'front', unit: 30 },
        ])
    })

    it('finds devices sharing units on the same face, lowest shared unit first', () => {
        const twoSaves = [
            ...placed,
            { assetId: 'sw2', ruStart: 31, height: 2, face: 'front' as const },
            { assetId: 'ap1', ruStart: 40, height: 1, face: 'front' as const },
        ]
        expect(overlaps(twoSaves)).toEqual([
            { assetIds: ['fw1', 'sw2'], face: 'front', unit: 31 },
            { assetIds: ['sw1', 'ap1'], face: 'front', unit: 40 },
        ])
    })

    it('lets devices share units on opposite faces, and counts a height under 1 as 1', () => {
        expect(overlaps([...placed, { assetId: 'pdu', ruStart: 30, height: 2, face: 'rear' }])).toEqual([])
        expect(overlaps([...placed, { assetId: 'blank', ruStart: 40, height: 0, face: 'front' }])).toEqual([
            { assetIds: ['sw1', 'blank'], face: 'front', unit: 40 },
        ])
    })

    it('compares two devices with the same name', () => {
        const unnamed = { assetId: '', ruStart: 5, height: 1, face: 'front' as const }
        expect(overlaps([unnamed, unnamed])).toEqual([{ assetIds: ['', ''], face: 'front', unit: 5 }])
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

/*
 * The rack rules' conditions are script text the platform runs as written (fluent/logic/assurance.now.ts), so they
 * spell the placement fields themselves: this ties them to the fields the checks read.
 */
describe('the rack rules', () => {
    const source = readFileSync(new URL('../../fluent/logic/assurance.now.ts', import.meta.url), 'utf8')
    const conditionOf = (id: string) => /condition:\s*\n?\s*"([^"]+)"/.exec(source.slice(source.indexOf(`Now.ID['${id}']`)))?.[1] ?? ''

    it('fire when any placement field changes', () => {
        for (const id of ['br_rack_placement', 'br_rack_recheck']) {
            for (const field of Object.values(PLACEMENT_FIELDS)) expect(conditionOf(id), `${id} ${field}`).toContain(`current.${field}.changes()`)
        }
    })

    it('check a kept placement only on an Asset that is in a rack', () => {
        expect(conditionOf('br_rack_placement_model')).toContain(`current.${PLACEMENT_FIELDS.rack} != ''`)
    })
})
