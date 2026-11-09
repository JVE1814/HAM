import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
    adoptionProblem,
    FLEET_FIELD,
    fleetCondition,
    fleetField,
    fleetStagesQuery,
    inFleet,
    isNaasModel,
    NAAS_STOCKROOM_TYPES,
    naasModelCondition,
    naasStockroomCondition,
    naasStockroomType,
    OEM_PID_FIELD,
    outsideFleetCondition,
    receiptProblem,
    STOCKROOM_TYPE_FIELD,
    type FleetCandidate,
} from './fleet'
import { ALL_STAGES, stagesQuery, type Stage } from './lifecycle'

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

/* The Fluent metadata spells the fields out as literals; they must be the ones this module names. */
describe('the Fluent metadata', () => {
    const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
    const augments = source('../../fluent/data/augments.now.ts')
    const table = (name: string) => augments.split(`export const ${name} = Table({`)[1]?.split('\n})')[0] ?? ''
    const column = (body: string, field: string) => body.split(`${field}:`)[1]?.split('}),')[0] ?? ''

    it('declares the Fleet flag on alm_hardware, default false, read-only and indexed', () => {
        const hardware = table('alm_hardware')
        const fleet = column(hardware, FLEET_FIELD)
        expect(fleet).toMatch(/^\s*BooleanColumn\(/)
        expect(fleet).toMatch(/label: 'Fleet'/)
        expect(fleet).toMatch(/default: false/)
        expect(fleet).toMatch(/readOnly: true/)
        expect(fleet).toMatch(/hint: '/)
        expect(hardware).toMatch(new RegExp(`element: '${FLEET_FIELD}'`))
    })

    it('stamps no NaaS value on the rows the Provider IT creates', () => {
        const DEFAULT = /^\s*default:|[{,]\s*default:/m
        expect(column(table('alm_hardware'), 'x_daas_ham_legal_owner')).not.toMatch(DEFAULT)
        expect(column(table('alm_hardware'), 'x_daas_ham_legal_owner')).not.toMatch(/dropdown_without_none/)
        expect(column(table('alm_stockroom'), STOCKROOM_TYPE_FIELD)).not.toMatch(DEFAULT)
        // The check itself finds a default where there is one.
        expect(column(table('alm_hardware'), FLEET_FIELD)).toMatch(DEFAULT)
        expect(table('cmdb_model')).toMatch(new RegExp(`${OEM_PID_FIELD}: StringColumn`))
    })

    it('offers only fleet assets as a case’s failed asset', () => {
        const failed = column(table('sn_customerservice_case'), 'x_daas_ham_failed_asset')
        expect(failed).toMatch(new RegExp(`referenceQual: '${fleetCondition()}'`))
    })

    it('offers Add to fleet only on an Asset not yet in the fleet', () => {
        const action = source('../../fluent/ui/fleet-actions.now.ts')
        expect(action).toMatch(new RegExp(`condition: 'current\\.${FLEET_FIELD} != true'`))
        expect(action).toMatch(/roles: \[assetManager, admin\]/)
    })
})
