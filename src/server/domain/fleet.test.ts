import { describe, expect, it } from 'vitest'
import {
    adoptionProblem,
    CURRENT_IS_FLEET,
    CURRENT_IS_FLEET_UNSPACED,
    CURRENT_NOT_FLEET,
    CURRENT_IS_NAAS_STOCKROOM,
    FLEET_FIELD,
    FLEET_IN_STAGE,
    fleetCondition,
    fleetStagesQuery,
    inFleet,
    isNaasModel,
    NAAS_MODEL_CONDITION,
    NAAS_STOCKROOM_CONDITION,
    NAAS_STOCKROOM_TYPES,
    naasModelCondition,
    naasStockroomCondition,
    naasStockroomType,
    outsideFleetCondition,
    outsideNaasStockroomCondition,
    providerStockroomCondition,
    receiptProblem,
    SITES_OF_CUSTOMER_QUERY,
    STOCKROOM_TYPE_FIELD,
    type FleetCandidate,
} from './fleet'
import { ALL_STAGES, type Stage } from './lifecycle'
import { recordMatches as matches } from '../test-support/encoded-query'
import { assetIn, through, type SampleRecord } from '../test-support/stored-asset'

const FLEET = { [FLEET_FIELD]: 'true' }
const OUTSIDE = { [FLEET_FIELD]: 'false' }
/** A row from before the Fleet flag column. */
const UNFLAGGED = { [FLEET_FIELD]: '' }

describe('the fleet condition', () => {
    it('finds the Assets flagged as fleet, on the Asset or through a reference to it', () => {
        expect([FLEET, OUTSIDE, UNFLAGGED].map((asset) => matches(fleetCondition(), asset))).toEqual([true, false, false])
        expect([FLEET, OUTSIDE, UNFLAGGED].map((asset) => matches(fleetCondition('asset.'), through('asset.', asset)))).toEqual([true, false, false])
        expect(matches(fleetCondition('asset.'), FLEET)).toBe(false)
    })

    it('counts a blank flag (a row from before the column) as outside the fleet', () => {
        expect([FLEET, OUTSIDE, UNFLAGGED].map((asset) => matches(outsideFleetCondition(), asset))).toEqual([false, true, true])
        expect([FLEET, OUTSIDE, UNFLAGGED].map((asset) => matches(outsideFleetCondition('asset.'), through('asset.', asset)))).toEqual([false, true, true])
    })

    it('keeps every alternative of a query to fleet assets', () => {
        const query = inFleet('install_status=1^NQinstall_status=6')
        for (const install_status of ['1', '6']) {
            expect(matches(query, { ...FLEET, install_status }), install_status).toBe(true)
            expect(matches(query, { ...OUTSIDE, install_status }), install_status).toBe(false)
            expect(matches(query, { ...UNFLAGGED, install_status }), install_status).toBe(false)
        }
        expect(matches(query, { ...FLEET, install_status: '7' })).toBe(false)
    })

    it('reads the flag through a reference when the query is on another table', () => {
        const query = inFleet('model=m1', 'asset.')
        expect(matches(query, through('asset.', FLEET, { model: 'm1' }))).toBe(true)
        expect(matches(query, through('asset.', OUTSIDE, { model: 'm1' }))).toBe(false)
        expect(matches(query, through('asset.', FLEET, { model: 'm2' }))).toBe(false)
    })

    it('finds every fleet asset, and no other, on an empty query', () => {
        expect([FLEET, OUTSIDE, UNFLAGGED].map((asset) => matches(inFleet(''), asset))).toEqual([true, false, false])
    })
})

/** A Stockroom of each NaaS type, the Provider IT's (no type) and one of a type NaaS does not have. */
const STOCKROOM_TYPES = ['central_depot', 'staging_centre', 'customer_site', '', 'it_storeroom'] as const
const typesFound = (condition: string, via = '') => STOCKROOM_TYPES.filter((type) => matches(condition, { [`${via}${STOCKROOM_TYPE_FIELD}`]: type }))

/*
 * Fluent metadata reads constants only, so each condition it takes exists as a constant text beside the list or the
 * function the server code uses: the two forms must say the same.
 */
describe('the conditions the metadata imports', () => {
    const holds = (condition: string, current: Record<string, unknown>) => new Function('current', `return ${condition}`)(current) as boolean

    it('find the NaaS stockrooms: those of a NaaS type, and none with another type or without one', () => {
        expect(typesFound(NAAS_STOCKROOM_CONDITION)).toEqual(NAAS_STOCKROOM_TYPES)
    })

    it("find a Customer's Sites once the Customer is appended, and none of its other locations", () => {
        const query = `${SITES_OF_CUSTOMER_QUERY}cust1`
        expect(matches(query, { x_daas_ham_is_site: 'true', company: 'cust1' })).toBe(true)
        expect(matches(query, { x_daas_ham_is_site: 'true', company: 'cust9' })).toBe(false)
        expect(matches(query, { x_daas_ham_is_site: 'false', company: 'cust1' })).toBe(false)
        expect(matches(query, { x_daas_ham_is_site: '', company: 'cust1' })).toBe(false)
    })

    it('list the fleet assets of one stage, and no other Asset', () => {
        for (const [stage, query] of Object.entries(FLEET_IN_STAGE)) {
            for (const flag of [FLEET, OUTSIDE, UNFLAGGED]) {
                expect(ALL_STAGES.filter((found) => matches(query, assetIn(found, flag))), stage).toEqual(flag === FLEET ? [stage] : [])
            }
        }
    })

    it('test the same in a script: the Fleet flag, and each NaaS stockroom type', () => {
        expect(holds(CURRENT_IS_FLEET, { [FLEET_FIELD]: true })).toBe(true)
        expect(holds(CURRENT_IS_FLEET, { [FLEET_FIELD]: false })).toBe(false)
        expect(holds(CURRENT_IS_FLEET, { [FLEET_FIELD]: '' })).toBe(false)
        for (const flag of [true, false, '']) {
            expect(holds(CURRENT_IS_FLEET_UNSPACED, { [FLEET_FIELD]: flag })).toBe(holds(CURRENT_IS_FLEET, { [FLEET_FIELD]: flag }))
            expect(holds(CURRENT_NOT_FLEET, { [FLEET_FIELD]: flag })).toBe(!holds(CURRENT_IS_FLEET, { [FLEET_FIELD]: flag }))
        }
        for (const type of NAAS_STOCKROOM_TYPES) expect(holds(CURRENT_IS_NAAS_STOCKROOM, { [STOCKROOM_TYPE_FIELD]: type }), type).toBe(true)
        expect(holds(CURRENT_IS_NAAS_STOCKROOM, { [STOCKROOM_TYPE_FIELD]: '' })).toBe(false)
        expect(holds(CURRENT_IS_NAAS_STOCKROOM, { [STOCKROOM_TYPE_FIELD]: 'it_storeroom' })).toBe(false)
    })
})

describe('fleetStagesQuery', () => {
    const stagesFound = (query: string, fields: SampleRecord) => ALL_STAGES.filter((stage) => matches(query, assetIn(stage, fields)))

    it('finds the fleet assets in the stages asked for that the base query keeps, and no Asset outside the fleet', () => {
        const query = fleetStagesQuery(['available', 'in_service'], 'model=m1')
        expect(stagesFound(query, { ...FLEET, model: 'm1' })).toEqual(['available', 'in_service'])
        expect(stagesFound(query, { ...FLEET, model: 'm2' })).toEqual([])
        expect(stagesFound(query, { ...OUTSIDE, model: 'm1' })).toEqual([])
        expect(stagesFound(query, { ...UNFLAGGED, model: 'm1' })).toEqual([])
    })

    it('reads the stage and the flag alike through a reference to the Asset', () => {
        const query = fleetStagesQuery(['in_service'], '', 'asset.')
        expect(matches(query, through('asset.', assetIn('in_service', FLEET)))).toBe(true)
        expect(matches(query, through('asset.', assetIn('in_service', OUTSIDE)))).toBe(false)
        expect(matches(query, through('asset.', assetIn('pending_in_service', FLEET)))).toBe(false)
        expect(matches(query, assetIn('in_service', FLEET))).toBe(false)
    })
})

describe('NaaS stockrooms', () => {
    it('are the stockrooms with a type', () => {
        expect(naasStockroomType('central_depot')).toBe('central_depot')
        expect(naasStockroomType('staging_centre')).toBe('staging_centre')
        expect(naasStockroomType('customer_site')).toBe('customer_site')
    })

    it('leave out a stockroom with no type (the Provider IT’s) or an unknown one', () => {
        expect(naasStockroomType('')).toBeNull()
        expect(naasStockroomType('it_storeroom')).toBeNull()
    })

    it('are found by their types through a reference, never by an empty type', () => {
        expect(typesFound(naasStockroomCondition('stockroom.'), 'stockroom.')).toEqual(NAAS_STOCKROOM_TYPES)
        expect(typesFound(naasStockroomCondition())).toEqual(NAAS_STOCKROOM_TYPES)
    })

    it('leave every other stockroom, one with no type included, to the condition for those outside NaaS', () => {
        expect(typesFound(outsideNaasStockroomCondition())).toEqual(['', 'it_storeroom'])
        expect(typesFound(outsideNaasStockroomCondition('from_stockroom.'), 'from_stockroom.')).toEqual(['', 'it_storeroom'])
    })

    it("are the Provider's own, its central depots and staging centres, beside a Customer's site stockroom", () => {
        expect(typesFound(providerStockroomCondition('stockroom.'), 'stockroom.')).toEqual(['central_depot', 'staging_centre'])
    })
})

describe('NaaS Models', () => {
    it('are the Models with an OEM PID', () => {
        expect(isNaasModel('C9300-48P-E')).toBe(true)
        expect(isNaasModel('')).toBe(false)
        expect(isNaasModel('  ')).toBe(false)
    })

    it('are found by that OEM PID, on the Model or through a reference to it', () => {
        expect(matches(NAAS_MODEL_CONDITION, { x_daas_ham_oem_pid: 'C9300-48P-E' })).toBe(true)
        expect(matches(NAAS_MODEL_CONDITION, { x_daas_ham_oem_pid: '' })).toBe(false)
        expect(matches(naasModelCondition('model.'), { 'model.x_daas_ham_oem_pid': 'C9300-48P-E' })).toBe(true)
        expect(matches(naasModelCondition('model.'), { 'model.x_daas_ham_oem_pid': '' })).toBe(false)
    })
})

const outside: FleetCandidate = {
    fleet: false,
    stage: 'available',
    modelPid: 'C9300-48P-E',
    stockroomType: 'central_depot',
    hasSite: false,
    hasAgreement: false,
}

describe('adoptionProblem', () => {
    it('adopts free stock in a NaaS stockroom, and units on their way', () => {
        expect(adoptionProblem(outside)).toBeNull()
        expect(adoptionProblem({ ...outside, stage: 'on_order', stockroomType: '' })).toBeNull()
        expect(adoptionProblem({ ...outside, stage: 'in_transit', stockroomType: '' })).toBeNull()
    })

    it('adopts a unit in service with its Site and Agreement', () => {
        const deployed = { ...outside, stage: 'in_service' as const, stockroomType: '' }
        expect(adoptionProblem({ ...deployed, hasSite: true, hasAgreement: true })).toBeNull()
        expect(adoptionProblem({ ...deployed, hasSite: true })).toMatch(/Site and Agreement/)
        expect(adoptionProblem({ ...deployed, hasAgreement: true })).toMatch(/Site and Agreement/)
    })

    it('refuses a fleet asset, which is in already', () => {
        expect(adoptionProblem({ ...outside, fleet: true })).toBe('it is already a fleet asset')
    })

    it('refuses a unit whose Model is not a NaaS Model', () => {
        expect(adoptionProblem({ ...outside, modelPid: '' })).toMatch(/no OEM PID/)
    })

    it('refuses free stock outside a NaaS stockroom', () => {
        expect(adoptionProblem({ ...outside, stockroomType: '' })).toMatch(/NaaS stockroom/)
    })

    it('refuses a unit in a stage NaaS does not model', () => {
        expect(adoptionProblem({ ...outside, stage: null })).toMatch(/a stage NaaS does not model/)
    })

    it('refuses every stage that carries context the app sets as it goes', () => {
        const adoptable: readonly Stage[] = ['on_order', 'in_transit', 'available', 'in_service']
        for (const stage of ALL_STAGES.filter((s) => !adoptable.includes(s))) {
            const unit = { ...outside, stage, hasSite: true, hasAgreement: true }
            expect(adoptionProblem(unit), stage).toBe(
                `only an asset on order, in transit, available or in service joins the fleet (this one is ${stage})`,
            )
        }
    })
})

describe('receiptProblem', () => {
    it('receives a fleet asset whatever its stage, for the receipt to judge', () => {
        expect(receiptProblem({ ...outside, fleet: true, stage: 'pending_return' }, false)).toBeNull()
        expect(receiptProblem({ ...outside, fleet: true, modelPid: '' }, true)).toBeNull()
    })

    it('takes in a unit outside the fleet awaiting receipt, of a NaaS Model', () => {
        expect(receiptProblem({ ...outside, stage: 'on_order', stockroomType: '' }, true)).toBeNull()
        expect(receiptProblem({ ...outside, stage: 'on_order', modelPid: '' }, true)).toMatch(/no OEM PID/)
    })

    it('leaves any other unit outside the fleet to the Provider IT', () => {
        expect(receiptProblem({ ...outside, stage: 'pending_return' }, false)).toBe(
            'it is not a fleet asset: an asset manager adds it to the fleet first',
        )
        expect(receiptProblem(outside, false)).toMatch(/not a fleet asset/)
    })
})
