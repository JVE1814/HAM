import { describe, expect, it } from 'vitest'
import { devicePlacement, overlaps, placementProblem, powerBudget, rackElevation } from './rack'

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

    it("tells devices apart by their id and names them by their label, which two may share", () => {
        const tagged = [
            { assetId: 'sys-a', label: 'NAAS-0001', ruStart: 30, height: 2, face: 'front' as const },
            { assetId: 'sys-b', label: '', ruStart: 20, height: 1, face: 'front' as const },
        ]
        // Another device with the same (or no) label still takes its units; one with none is named by its id.
        expect(placementProblem(rack42, tagged, { assetId: 'sys-c', label: 'NAAS-0001', ruStart: 31, height: 1, face: 'front' })).toBe(
            'Rack unit 31 is taken by NAAS-0001',
        )
        expect(placementProblem(rack42, tagged, { assetId: 'sys-c', label: '', ruStart: 20, height: 1, face: 'front' })).toBe(
            'Rack unit 20 is taken by sys-b',
        )
        // The device's own earlier placement is left out by its id, whatever its label now.
        expect(placementProblem(rack42, tagged, { assetId: 'sys-a', label: 'NAAS-0099', ruStart: 31, height: 1, face: 'front' })).toBeNull()
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
            { assetIds: ['fw1', 'low'], labels: ['fw1', 'low'], face: 'front', unit: 30 },
        ])
    })

    it('finds devices sharing units on the same face, lowest shared unit first', () => {
        const twoSaves = [
            ...placed,
            { assetId: 'sw2', ruStart: 31, height: 2, face: 'front' as const },
            { assetId: 'ap1', ruStart: 40, height: 1, face: 'front' as const },
        ]
        expect(overlaps(twoSaves)).toEqual([
            { assetIds: ['fw1', 'sw2'], labels: ['fw1', 'sw2'], face: 'front', unit: 31 },
            { assetIds: ['sw1', 'ap1'], labels: ['sw1', 'ap1'], face: 'front', unit: 40 },
        ])
    })

    it('lets devices share units on opposite faces, and counts a height under 1 as 1', () => {
        expect(overlaps([...placed, { assetId: 'pdu', ruStart: 30, height: 2, face: 'rear' }])).toEqual([])
        expect(overlaps([...placed, { assetId: 'blank', ruStart: 40, height: 0, face: 'front' }])).toEqual([
            { assetIds: ['sw1', 'blank'], labels: ['sw1', 'blank'], face: 'front', unit: 40 },
        ])
    })

    it('compares two devices with the same name', () => {
        const unnamed = { assetId: '', ruStart: 5, height: 1, face: 'front' as const }
        expect(overlaps([unnamed, unnamed])).toEqual([{ assetIds: ['', ''], labels: ['', ''], face: 'front', unit: 5 }])
    })

    it('reports the two devices by id and by label', () => {
        const a = { assetId: 'sys-a', label: 'NAAS-0001', ruStart: 5, height: 1, face: 'front' as const }
        const b = { assetId: 'sys-b', label: 'FOC123', ruStart: 5, height: 1, face: 'front' as const }
        expect(overlaps([a, b])).toEqual([{ assetIds: ['sys-a', 'sys-b'], labels: ['NAAS-0001', 'FOC123'], face: 'front', unit: 5 }])
    })
})

describe('rackElevation', () => {
    it('lists units top-down with each device once at its top unit', () => {
        const rows = rackElevation(4, [{ assetId: 'sys-a', label: 'NAAS-0001', ruStart: 2, height: 2, face: 'front' }], 'front')
        expect(rows).toEqual([
            { unit: 4, assetId: null, label: null, span: 1 },
            { unit: 3, assetId: 'sys-a', label: 'NAAS-0001', span: 2 },
            { unit: 1, assetId: null, label: null, span: 1 },
        ])
    })
})

describe('devicePlacement', () => {
    const device = { id: 'sys-a', tag: 'NAAS-0001', serial: 'FOC1', ruStart: 30, height: 2, face: 'front' as const, powerW: 250 }

    it('keys the device by its sys_id and names it by its asset tag, else its serial number', () => {
        expect(devicePlacement(device)).toEqual({ assetId: 'sys-a', label: 'NAAS-0001', ruStart: 30, height: 2, face: 'front', powerW: 250 })
        expect(devicePlacement({ ...device, tag: '' }).label).toBe('FOC1')
        expect(devicePlacement({ ...device, height: 0 }).height).toBe(1)
    })

    it('never counts a device re-saved in its own units as overlapping itself, whatever its tag', () => {
        // The rule reads the device among the rack's placements and as the candidate, the same sys_id both times.
        const others = [devicePlacement(device), devicePlacement({ ...device, id: 'sys-b', ruStart: 10, height: 1 })]
        expect(placementProblem(rack42, others, devicePlacement({ ...device, tag: 'NAAS-0099' }))).toBeNull()
        // A device that only shares its tag is another device, and still takes its units.
        expect(placementProblem(rack42, others, devicePlacement({ ...device, id: 'sys-c', ruStart: 31, height: 1 }))).toBe('Rack unit 31 is taken by NAAS-0001')
    })

    it('draws two devices sharing a tag, and one with neither a tag nor a serial, as separate devices', () => {
        const shared = [
            devicePlacement({ ...device, ruStart: 3, height: 1 }),
            devicePlacement({ ...device, id: 'sys-b', ruStart: 2, height: 1 }),
            devicePlacement({ ...device, id: 'sys-c', tag: '', serial: '', ruStart: 1, height: 1 }),
        ]
        expect(rackElevation(3, shared, 'front')).toEqual([
            { unit: 3, assetId: 'sys-a', label: 'NAAS-0001', span: 1 },
            { unit: 2, assetId: 'sys-b', label: 'NAAS-0001', span: 1 },
            { unit: 1, assetId: 'sys-c', label: 'sys-c', span: 1 },
        ])
    })
})
