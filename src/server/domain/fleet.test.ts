import { describe, expect, it } from 'vitest'
import {
    adoptionProblem,
    CURRENT_IS_FLEET,
    CURRENT_IS_NAAS_STOCKROOM,
    FLEET_CONDITION,
    FLEET_FIELD,
    FLEET_IN_STAGE,
    fleetCondition,
    fleetField,
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
    receiptProblem,
    SITE_CONDITION,
    SITES_OF_CUSTOMER_QUERY,
    STOCKROOM_TYPE_FIELD,
    type FleetCandidate,
} from './fleet'
import { ALL_STAGES, stagesQuery, type Stage } from './lifecycle'
import { STOCKROOM_TYPE_CHOICES } from './vocabulary'

describe('the fleet condition', () => {
    it('names the Fleet flag, dot-walked from another table when asked', () => {
        expect(fleetField()).toBe('x_daas_ham_fleet')
        expect(fleetCondition()).toBe('x_daas_ham_fleet=true')
        expect(fleetCondition('asset.')).toBe('asset.x_daas_ham_fleet=true')
    })

    it('counts a blank flag (a row from before the column) as outside the fleet', () => {
        expect(outsideFleetCondition()).toBe('x_daas_ham_fleet=false^ORx_daas_ham_fleetISEMPTY')
        expect(outsideFleetCondition('asset.')).toBe('asset.x_daas_ham_fleet=false^ORasset.x_daas_ham_fleetISEMPTY')
    })

    it('is ANDed into every top-level OR clause of a query', () => {
        expect(inFleet('install_status=1^NQinstall_status=6')).toBe(
            'install_status=1^x_daas_ham_fleet=true^NQinstall_status=6^x_daas_ham_fleet=true',
        )
        expect(inFleet('model=m1', 'asset.')).toBe('model=m1^asset.x_daas_ham_fleet=true')
    })

    it('stands alone on an empty query', () => {
        expect(inFleet('')).toBe('x_daas_ham_fleet=true')
    })
})

/*
 * Fluent metadata reads constants only, so each condition it takes exists as a constant text beside the list or the
 * function the server code uses: the two forms must say the same.
 */
describe('the conditions the metadata imports', () => {
    /** Whether a script condition holds for `current`, a record with these field values. */
    const holds = (condition: string, current: Record<string, unknown>) => new Function('current', `return ${condition}`)(current) as boolean

    it('are the conditions the server code builds', () => {
        expect(FLEET_CONDITION).toBe(fleetCondition())
        expect(NAAS_MODEL_CONDITION).toBe(naasModelCondition())
        expect(NAAS_STOCKROOM_CONDITION).toBe(`${STOCKROOM_TYPE_FIELD}IN${NAAS_STOCKROOM_TYPES.join(',')}`)
        expect(NAAS_STOCKROOM_CONDITION).toBe(naasStockroomCondition())
        expect(SITES_OF_CUSTOMER_QUERY).toBe(`${SITE_CONDITION}^company=`)
    })

    it('name every stockroom type as a NaaS stockroom’s', () => {
        expect([...NAAS_STOCKROOM_TYPES].sort()).toEqual(Object.keys(STOCKROOM_TYPE_CHOICES).sort())
    })

    it('list the fleet assets of one stage as fleetStagesQuery does', () => {
        for (const [stage, query] of Object.entries(FLEET_IN_STAGE)) expect({ stage, query }).toEqual({ stage, query: fleetStagesQuery([stage as Stage]) })
    })

    it('test the same in a script: the Fleet flag, and each NaaS stockroom type', () => {
        expect(holds(CURRENT_IS_FLEET, { [FLEET_FIELD]: true })).toBe(true)
        expect(holds(CURRENT_IS_FLEET, { [FLEET_FIELD]: false })).toBe(false)
        expect(holds(CURRENT_IS_FLEET, { [FLEET_FIELD]: '' })).toBe(false)
        for (const type of NAAS_STOCKROOM_TYPES) expect(holds(CURRENT_IS_NAAS_STOCKROOM, { [STOCKROOM_TYPE_FIELD]: type }), type).toBe(true)
        expect(holds(CURRENT_IS_NAAS_STOCKROOM, { [STOCKROOM_TYPE_FIELD]: '' })).toBe(false)
        expect(holds(CURRENT_IS_NAAS_STOCKROOM, { [STOCKROOM_TYPE_FIELD]: 'it_storeroom' })).toBe(false)
    })
})

describe('fleetStagesQuery', () => {
    it('keeps every stage clause to fleet assets', () => {
        const query = fleetStagesQuery(['available', 'in_service'], 'model=m1')
        const clauses = query.split('^NQ')
        expect(clauses).toHaveLength(2)
        for (const clause of clauses) expect(clause).toMatch(/\^model=m1\^x_daas_ham_fleet=true$/)
        expect(query).toBe(`${stagesQuery(['available'], 'model=m1')}^x_daas_ham_fleet=true^NQ${stagesQuery(['in_service'], 'model=m1')}^x_daas_ham_fleet=true`)
    })

    it('dot-walks the stage and the flag alike', () => {
        expect(fleetStagesQuery(['in_service'], '', 'asset.')).toBe('asset.install_status=1^asset.substatusISEMPTY^asset.x_daas_ham_fleet=true')
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

    it('are queried by their types, never by an empty one', () => {
        expect(naasStockroomCondition('stockroom.')).toBe(
            'stockroom.x_daas_ham_stockroom_typeINcentral_depot,staging_centre,customer_site',
        )
        expect(NAAS_STOCKROOM_TYPES).not.toContain('')
    })
})

describe('NaaS Models', () => {
    it('are the Models with an OEM PID', () => {
        expect(isNaasModel('C9300-48P-E')).toBe(true)
        expect(isNaasModel('')).toBe(false)
        expect(isNaasModel('  ')).toBe(false)
        expect(naasModelCondition('model.')).toBe('model.x_daas_ham_oem_pidISNOTEMPTY')
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
