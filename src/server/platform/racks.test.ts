import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fieldsOf } from '../domain/lifecycle.ts'
import { ROLE } from '../domain/roles.ts'
import { rackElevation, racksAtSite, visibleSites } from './racks.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

function site(id: string, name: string, company: string, fields: Row = {}): Row {
    return { sys_id: id, name, company, x_daas_ham_is_site: 'true', x_daas_ham_site_contacts: '', ...fields }
}

function rack(id: string, name: string, location: string, fields: Row = {}): Row {
    return { sys_id: id, name, location, ...fields }
}

/** A fleet asset in service, placed in a rack. */
function device(id: string, rackId: string, ruStart: string, fields: Row = {}): Row {
    const { installStatus, substatus } = fieldsOf('in_service')
    return {
        sys_id: id,
        asset_tag: `NAAS-${id}`,
        serial_number: `FOC-${id}`,
        x_daas_ham_fleet: 'true',
        company: 'acme',
        model: 'm1',
        install_status: installStatus,
        substatus: substatus ?? '',
        x_daas_ham_rack: rackId,
        x_daas_ham_ru_start: ruStart,
        ...fields,
    }
}

let users = 0

/**
 * Sign in as a new user of `company` holding `role`, listed as a contact of `contactOf`. Each is a new user: the
 * session module keeps a user's scope, Customer and Sites for as long as it is loaded (on the platform, a transaction).
 * The id ends in a dot so that no id is part of another: a contact is found by its id within the Site's list.
 */
function signIn(role: string, company: string, contactOf: readonly string[] = []): void {
    const userId = `user${++users}.`
    platform.user = { id: userId, name: '', company, roles: [role], interactive: true }
    for (const location of platform.tables.cmn_location ?? []) {
        if (contactOf.includes(location.sys_id ?? '')) location.x_daas_ham_site_contacts = `someone,${userId}`
    }
}

const names = (listed: ReadonlyArray<{ name: string }> | null) => listed?.map((entry) => entry.name) ?? null

beforeEach(() => {
    platform.reset()
    platform.references = {
        'cmn_location.company': 'core_company',
        'cmn_location.parent': 'cmn_location',
        'cmdb_ci_rack.location': 'cmn_location',
    }
    platform.tables.core_company = [
        { sys_id: 'acme', name: 'Acme' },
        { sys_id: 'globex', name: 'Globex' },
    ]
    platform.tables.cmn_location = [
        site('acme-hq', 'Acme HQ', 'acme'),
        site('acme-branch', 'Acme Branch', 'acme'),
        site('globex-hq', 'Globex HQ', 'globex'),
        // A Room of a Site, and a room of the Provider IT's: neither is a Site.
        { sys_id: 'acme-room', name: 'Comms room', company: 'acme', parent: 'acme-hq' },
        { sys_id: 'provider-dc', name: 'Provider data centre', company: 'provider-co' },
    ]
    platform.tables.cmdb_ci_rack = [
        rack('rack-hq', 'HQ-1', 'acme-hq', { rack_units: '12', x_daas_ham_power_capacity_w: '1000' }),
        rack('rack-room', 'HQ-2', 'acme-room'),
        rack('rack-branch', 'BR-1', 'acme-branch'),
        rack('rack-globex', 'GX-1', 'globex-hq'),
        rack('rack-dc', 'DC-1', 'provider-dc'),
    ]
    platform.tables.cmdb_model = [{ sys_id: 'm1', display_name: 'Catalyst 9300', rack_units: '2', power_consumption: '350' }]
    platform.tables.alm_hardware = []
})

describe('the Sites a user may pick a rack at', () => {
    it("are their Customer's for a Customer admin, by name, and no other Customer's", () => {
        signIn(ROLE.customerAdmin, 'acme')

        expect(visibleSites()).toEqual([
            { id: 'acme-branch', name: 'Acme Branch', customer: 'Acme' },
            { id: 'acme-hq', name: 'Acme HQ', customer: 'Acme' },
        ])
    })

    it('are the Sites that list them for a site contact', () => {
        signIn(ROLE.siteContact, 'acme', ['acme-hq'])

        expect(names(visibleSites())).toEqual(['Acme HQ'])
    })

    it("leave out another Customer's Site that lists the site contact", () => {
        signIn(ROLE.siteContact, 'acme', ['acme-hq', 'globex-hq'])

        expect(names(visibleSites())).toEqual(['Acme HQ'])
    })

    it('are none for a site contact no Site lists', () => {
        signIn(ROLE.siteContact, 'acme')

        expect(visibleSites()).toEqual([])
    })

    it('are none for a Customer admin whose user has no company', () => {
        signIn(ROLE.customerAdmin, '')

        expect(visibleSites()).toEqual([])
    })

    it.each([ROLE.assetManager, ROLE.noc, ROLE.inventoryTech])("are every Customer's for staff (%s), and never a location that is no Site", (role) => {
        signIn(role, 'provider-co')

        expect(names(visibleSites())).toEqual(['Acme Branch', 'Acme HQ', 'Globex HQ'])
    })
})

describe('the racks at a Site', () => {
    it("are listed by name for the Site's Customer admin, those in its Rooms included", () => {
        signIn(ROLE.customerAdmin, 'acme')

        expect(racksAtSite('acme-hq')).toEqual([
            { id: 'rack-hq', name: 'HQ-1', room: 'Acme HQ' },
            { id: 'rack-room', name: 'HQ-2', room: 'Comms room' },
        ])
    })

    it("are not told of another Customer's Site: it reads as no Site", () => {
        signIn(ROLE.customerAdmin, 'acme')

        expect(racksAtSite('globex-hq')).toBeNull()
    })

    it("are not told a site contact of a Site of their Customer's that does not list them", () => {
        signIn(ROLE.siteContact, 'acme', ['acme-hq'])

        expect(names(racksAtSite('acme-hq'))).toEqual(['HQ-1', 'HQ-2'])
        expect(racksAtSite('acme-branch')).toBeNull()
    })

    it("are not told a site contact of another Customer's Site that lists them", () => {
        signIn(ROLE.siteContact, 'acme', ['globex-hq'])

        expect(racksAtSite('globex-hq')).toBeNull()
    })

    it("are listed for staff at any Customer's Site", () => {
        signIn(ROLE.noc, 'provider-co')

        expect(names(racksAtSite('globex-hq'))).toEqual(['GX-1'])
    })

    it.each([
        ['a Room of a Site', 'acme-room'],
        ["a room of the Provider IT's", 'provider-dc'],
        ['a location that does not exist', 'nowhere'],
        ['no location', ''],
    ])('are not listed for %s, to staff either', (_what, locationId) => {
        signIn(ROLE.assetManager, 'provider-co')

        expect(racksAtSite(locationId)).toBeNull()
    })

    it('are an empty list at a Site that has none', () => {
        platform.tables.cmdb_ci_rack = []
        signIn(ROLE.customerAdmin, 'acme')

        expect(racksAtSite('acme-hq')).toEqual([])
    })
})

describe('the elevation of a rack', () => {
    it("is given to the Customer admin of the rack's Site, for a rack in one of its Rooms too", () => {
        signIn(ROLE.customerAdmin, 'acme')

        expect(rackElevation('rack-hq')?.rack).toEqual({ id: 'rack-hq', name: 'HQ-1', units: 12, power: { capacityW: 1000, usedW: 0, utilisation: 0 } })
        expect(rackElevation('rack-room')?.rack.name).toBe('HQ-2')
    })

    it("is not given of another Customer's rack: it reads as no rack", () => {
        platform.tables.alm_hardware = [device('g1', 'rack-globex', '1', { company: 'globex' })]
        signIn(ROLE.customerAdmin, 'acme')

        expect(rackElevation('rack-globex')).toBeNull()
    })

    it("is given to a site contact for a rack at a Site that lists them, and not at another Site of their Customer's", () => {
        signIn(ROLE.siteContact, 'acme', ['acme-hq'])

        expect(rackElevation('rack-hq')?.rack.id).toBe('rack-hq')
        expect(rackElevation('rack-room')?.rack.id).toBe('rack-room')
        expect(rackElevation('rack-branch')).toBeNull()
    })

    it("is not given to a site contact of another Customer's rack at a Site that lists them", () => {
        signIn(ROLE.siteContact, 'acme', ['globex-hq'])

        expect(rackElevation('rack-globex')).toBeNull()
    })

    it.each([
        ["a rack in a room of the Provider IT's", 'rack-dc'],
        ['a rack that does not exist', 'no-such-rack'],
        ['no rack', ''],
    ])('is not given of %s, to staff either', (_what, rackId) => {
        signIn(ROLE.assetManager, 'provider-co')

        expect(rackElevation(rackId)).toBeNull()
    })

    it('is not given of a rack that stands at no location', () => {
        platform.tables.cmdb_ci_rack = [rack('rack-loose', 'Loose', '')]
        signIn(ROLE.assetManager, 'provider-co')

        expect(rackElevation('rack-loose')).toBeNull()
    })

    it('lists the fleet assets placed in the rack with what the page shows of each, and the power they draw', () => {
        platform.tables.alm_hardware = [
            device('a1', 'rack-hq', '1', {
                x_daas_ham_rack_face: 'rear',
                x_daas_ham_lifecycle_phase: 'available',
                x_daas_ham_coverage_end: '2027-06-30',
                x_daas_ham_refresh_due: '2028-11-09',
            }),
            device('g1', 'rack-hq', '5', { company: 'globex', model: 'gone' }),
            // Not in the elevation: the Provider IT's, not placed on a unit, and placed in another rack.
            device('it1', 'rack-hq', '7', { x_daas_ham_fleet: '' }),
            device('a2', 'rack-hq', ''),
            device('a3', 'rack-room', '1'),
        ]
        signIn(ROLE.assetManager, 'provider-co')

        expect(rackElevation('rack-hq')).toEqual({
            rack: { id: 'rack-hq', name: 'HQ-1', units: 12, power: { capacityW: 1000, usedW: 350, utilisation: 35 } },
            devices: [
                {
                    id: 'a1',
                    tag: 'NAAS-a1',
                    serial: 'FOC-a1',
                    stage: 'in_service',
                    lifecyclePhase: 'available',
                    coverageEnd: '2027-06-30',
                    refreshDue: '2028-11-09',
                    customer: 'Acme',
                    model: 'Catalyst 9300',
                    ruStart: 1,
                    height: 2,
                    face: 'rear',
                },
                {
                    id: 'g1',
                    tag: 'NAAS-g1',
                    serial: 'FOC-g1',
                    stage: 'in_service',
                    lifecyclePhase: '',
                    coverageEnd: '',
                    refreshDue: '',
                    customer: 'Globex',
                    // Its Model is gone: no name, one unit high, no draw.
                    model: '',
                    ruStart: 5,
                    height: 1,
                    face: 'front',
                },
            ],
        })
    })

    it('reads a rack that records no height as 42 units and one with no power capacity as having no budget', () => {
        platform.tables.alm_hardware = [device('a3', 'rack-room', '1')]
        signIn(ROLE.assetManager, 'provider-co')

        expect(rackElevation('rack-room')?.rack).toEqual({ id: 'rack-room', name: 'HQ-2', units: 42, power: { capacityW: 0, usedW: 350, utilisation: null } })
    })
})
