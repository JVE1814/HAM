# Plan 027: Test that the rack and site routes show a Customer only its own Sites and racks

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- src/server/platform/racks.ts src/server/entry/racks.ts src/server/platform/session.ts src/server/platform/rest-api.ts src/server/domain/visibility.ts src/server/domain/roles.ts src/server/domain/fleet.ts src/server/domain/rack.ts src/server/test-support/fake-glide.ts src/server/test-support/encoded-query.ts src/server/platform/racks.test.ts src/server/entry/racks.test.ts`
> The first ten paths are the code under test and the fake it runs on. The
> last two are the files you create, and must not exist yet. If any of the
> ten changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding. On a mismatch, treat it
> as a STOP condition. A change to `fake-glide.ts` that only adds a method
> (another plan adds one) is not a mismatch.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

Customer users call three REST routes of the rack page: `GET /sites`, `GET /racks?site=` and
`GET /racks/{id}`. The last one lists serial numbers, asset tags and Customer names. The platform
table behind them, `cmn_location`, has no before-query rule and no read ACL of the app, so the only
thing that keeps a Customer admin or a site contact to their own Sites is a filter that
`src/server/platform/racks.ts` builds by hand. No unit test and no ATF test reaches that filter.
`src/fluent/racks/tests.now.ts` holds one ATF test, on the rack power budget, and the cross-tenant
ATF tests of plan 012 cover the `customer/...` routes, not these three. A change that drops the
filter, or checks the Customer and forgets the Site, would show one Customer another Customer's
racks and every check would stay green.

This plan adds 37 unit tests that pin what the code does today. It changes no behaviour. The tests
were written against commit `805d5da` and all pass there, so **a test that fails on the current
code is a finding to report, not a defect to fix in this plan**.

## Current state

Files and their roles:

- `src/server/platform/racks.ts`. `visibleSites`, `racksAtSite` and `rackElevation` read Sites, racks and the devices in a rack for the signed-in user. Not changed.
- `src/server/entry/racks.ts`. `listSites`, `listRacks` and `getRack` are the REST route handlers. Each checks the caller's role, calls the platform function and turns `null` into HTTP 404. Not changed.
- `src/server/platform/session.ts`. `currentSession()` gives the signed-in user's scope, Customer and Sites. Not changed.
- `src/server/domain/visibility.ts`. `visibilityFilter` turns a scope into an encoded query. Already unit-tested in `src/server/domain/visibility.test.ts`.
- `src/server/test-support/fake-glide.ts`. The in-memory Glide the tests run on. Not changed.
- `src/server/platform/racks.test.ts` and `src/server/entry/racks.test.ts`. Do not exist. You create them.

Who may call the routes. Customer admins and site contacts are on the list:

```ts
// src/server/domain/roles.ts:72-81
export const RACK_PAGE_USERS = [
    ROLE.assetManager,
    ROLE.inventoryTech,
    ROLE.fieldTech,
    ROLE.noc,
    ROLE.accountManager,
    ROLE.finance,
    ROLE.customerAdmin,
    ROLE.siteContact,
]
```

The hand-built tenant check:

```ts
// src/server/platform/racks.ts:175-181
const LOCATION_SCOPING: TableScoping = { customer: 'company', site: 'sys_id' }

/** The reader's visibility filter on Locations, or null for staff, who see every Site. */
function siteFilter(): string | null {
    const session = currentSession()
    return visibilityFilter(session.scope, LOCATION_SCOPING, session)
}
```

```ts
// src/server/platform/racks.ts:191-196
function seesSite(locationIds: readonly string[]): boolean {
    const ids = locationIds.filter(Boolean)
    if (ids.length === 0) return false
    const filter = siteFilter()
    return exists('cmn_location', [`sys_idIN${ids.join(',')}`, SITE_CONDITION, ...(filter ? [filter] : [])].join('^'))
}
```

The comment above `seesSite` (lines 183-190) says why it exists: "Locations have no before-query
rule, so the rack endpoints check this before reading a rack." It also says that a location that is
no Site "holds no rack the app places fleet assets in (ADR 0016), and its racks are shown to no one,
staff included."

The three functions that use it:

```ts
// src/server/platform/racks.ts:200-205
export function visibleSites(): Site[] {
    const site = new GlideRecord('cmn_location')
    site.addEncodedQuery(SITE_CONDITION)
    const filter = siteFilter()
    if (filter) site.addEncodedQuery(filter)
    site.orderBy('name')
```

```ts
// src/server/platform/racks.ts:219-222
export function racksAtSite(siteId: string): RackListing[] | null {
    // The Site is read first so the visibility check and the rack query below use the same sys_id.
    const site = findById('cmn_location', siteId)
    if (!site || !seesSite([site.getUniqueValue()])) return null
```

```ts
// src/server/platform/racks.ts:238-242
export function rackElevation(rackId: string): RackElevation | null {
    const rack = new GlideRecord('cmdb_ci_rack')
    if (!rack.get(rackId) || !seesSite(SITE_OR_ROOM_LOCATIONS.map((location) => str(rack, location)))) return null
    const asset = placedIn(rack.getUniqueValue())
    asset.query()
```

`SITE_CONDITION` is `x_daas_ham_is_site=true` (`src/server/domain/fleet.ts:155`).
`SITE_OR_ROOM_LOCATIONS` is `['location', 'location.parent']` (`src/server/domain/fleet.ts:166`): a
rack stands at a Site or in a Room whose parent is a Site.

What the filter is for each scope (`src/server/domain/visibility.ts:163-176`). A Customer admin
(scope `own_customer`) gets `company=<their company>`, or `sys_id=-1` when their user has no
company. A site contact (scope `own_sites`) gets `company=<their company>` and
`sys_idIN<the Sites that list them>`, or `sys_id=-1` when no Site lists them. Staff get no filter.
An inventory tech gets no filter here either, because `LOCATION_SCOPING` names no Stockroom.

The Sites that list a site contact are read once per user:

```ts
// src/server/platform/session.ts:29-30
// Contacts are a comma-separated list of 32-character sys_ids: a whole sys_id matches only its own entry.
const sitesOf = memoized((userId) => pluck('cmn_location', `x_daas_ham_site_contactsLIKE${userId}`, 'sys_id'))
```

The route handlers:

```ts
// src/server/entry/racks.ts:39-55
function allowed(response: RESTAPIResponse): boolean {
    return requireRole(response, RACK_PAGE_USERS, 'Requires a NaaS role')
}

export function listRacks(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const racks = racksAtSite(queryParam(request, 'site'))
    if (!racks) return reply(response, 404, { error: 'No such site' })
    reply(response, 200, { racks } satisfies RackList)
}

export function getRack(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const elevation = rackElevation(pathParam(request, 'id'))
    if (!elevation) return reply(response, 404, { error: 'No such rack' })
    reply(response, 200, elevation)
}
```

Conventions that apply (from `AGENTS.md` and `README.md` "Development"):

- A test is a `*.test.ts` file beside the module it tests. The build leaves it out of the app.
- A relative import in `src/server` names the `.ts` file (`'./racks.ts'`, not `'./racks'`).
- A test of `platform/` or `entry/` runs against `test-support/fake-glide.ts`. Each test file mocks Glide with this exact line, after its imports:
  `vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)`
- Use the words of `CONTEXT.md` in test names: Customer, Site, Room, Provider, fleet asset.
- Model the structure on `src/server/platform/customer-page.test.ts` (signing in as a user) and `src/server/entry/customer.test.ts` (calling a route handler).

What the tests rely on in the fake (`src/server/test-support/fake-glide.ts`):

- `platform.reset()` clears everything. `platform.tables[table]` holds the stored rows, and a test seeds and reads them directly.
- `platform.user = { id, name, company, roles, interactive }` is the signed-in user. `gs.hasRole(role)` is true only for a role in `roles`: the fake knows no role containment.
- `session.ts` keeps a user's scope, Customer and Sites in module state for as long as the module is loaded, which in a test file is every test. So each test signs in as a new user id. The ids end in a dot (`user1.`) so that no id is part of another: a contact is found with `LIKE`, which matches a substring.
- A dot-walk through a reference the test did not declare in `platform.references` throws an error that starts with `fake Glide:`. The tests declare `cmdb_ci_rack.location`, `cmn_location.parent` and `cmn_location.company`.
- A reference's display value is the referenced row's `display_name`, `number`, `name` or `sys_id`, the first that is set.
- The fake runs no business rule, ACL or flow. This matters for one case, see below.

What these tests cannot show. On an instance the devices of `rackElevation` are read with the
before-query rule on `alm_hardware`, so a Customer admin sees only their own Customer's devices in a
rack. The fake runs no rule, so on the fake every fleet asset placed in the rack is listed. The
device test therefore signs in as staff, who see every device on an instance too. That the rule
narrows the devices for a Customer is a check on an instance, and it is not part of this plan.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| One test file | `npx vitest run src/server/platform/racks.test.ts` | all pass |
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| Full gate | `npm run check` | typecheck, lint, build and all tests pass |

`npx vitest run <path>` needs no build. The full run does: `src/server/built-metadata.test.ts`
fails when a source file is newer than `dist/app`. A `*.test.ts` file under `src/server` does not
count as a source there (`now.config.json` `serverModulesExcludePatterns`), so this plan does not
make `dist` stale. `npm run check` runs `npm run build`, which rewrites `dist/` and may rewrite the
tracked `src/fluent/generated/keys.ts`. This plan adds no metadata, so `git status --short` must
show no change to `keys.ts` afterwards.

## Scope

**In scope** (the only files you create or modify):

- `src/server/platform/racks.test.ts` (create)
- `src/server/entry/racks.test.ts` (create)
- `plans/README.md` (your status row only)

**Out of scope** (do NOT touch):

- `src/server/platform/racks.ts`, `src/server/entry/racks.ts`, `src/server/platform/session.ts` and every other non-test file. This plan changes no behaviour, even where a test shows behaviour you think is wrong.
- `src/server/test-support/fake-glide.ts`. The tests need nothing the fake lacks. If one throws `fake Glide:`, stop.
- `placementRefusal`, `recheckRacksOf` and `recheckFlaggedRacks` in `racks.ts`. They are the rack rules, a different finding.
- An ATF test of the three routes. It is deferred (see "Maintenance notes").

## Git workflow

- Branch: `advisor/027-rack-route-tenant-tests`
- One commit. Subject in the repo's style (an imperative sentence under 72 characters), for example:
  `Test the tenant check of the rack and site routes`
  The body says that no test reached `seesSite` or the Site filter of `visibleSites`, and that the tests pin the behaviour as it is at `805d5da`.
- Do NOT push or open a PR unless the operator told you to.

## Steps

### Step 1: Record the baseline

**Verify**: `npx vitest run src/server/platform src/server/entry` → all pass. `ls src/server/platform/racks.test.ts src/server/entry/racks.test.ts` → both "No such file".

### Step 2: Create the platform tests

Create `src/server/platform/racks.test.ts` with exactly this content:

```ts
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
```

**Verify**: `npx vitest run src/server/platform/racks.test.ts` → `Tests  28 passed (28)`.

### Step 3: Create the route tests

Create `src/server/entry/racks.test.ts` with exactly this content:

```ts
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ROLE } from '../domain/roles.ts'
import { getRack, listRacks, listSites } from './racks.ts'
import { platform } from '../test-support/fake-glide.ts'

/*
 * The rack routes on the in-memory stand-in for the platform, as a Customer admin calls them. Who may see which Site
 * and rack is tested in platform/racks.test.ts: these tests cover what the routes add, the role guard and the 404 that
 * hides another Customer's Site or rack.
 */

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

type Handler = (request: RESTAPIRequest, response: RESTAPIResponse) => void

/** The platform passes each query parameter as an array. */
function get(handler: Handler, params: { query?: Record<string, string[]>; path?: Record<string, string> } = {}): { status: number; body: unknown } {
    const reply = { status: 0, body: null as unknown }
    const request = { pathParams: params.path ?? {}, queryParams: params.query ?? {} } as unknown as RESTAPIRequest
    const response = {
        setStatus: (status: number) => void (reply.status = status),
        setBody: (body: unknown) => void (reply.body = body),
    } as unknown as RESTAPIResponse
    handler(request, response)
    return reply
}

let users = 0

/** Each is a new user: the session module keeps a user's scope and Customer for as long as it is loaded. */
function signIn(roles: string[]): void {
    platform.user = { id: `caller${++users}.`, name: '', company: 'acme', roles, interactive: true }
}

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
        { sys_id: 'acme-hq', name: 'Acme HQ', company: 'acme', x_daas_ham_is_site: 'true' },
        { sys_id: 'globex-hq', name: 'Globex HQ', company: 'globex', x_daas_ham_is_site: 'true' },
    ]
    platform.tables.cmdb_ci_rack = [
        { sys_id: 'rack-hq', name: 'HQ-1', location: 'acme-hq' },
        { sys_id: 'rack-globex', name: 'GX-1', location: 'globex-hq' },
    ]
    platform.tables.alm_hardware = []
    signIn([ROLE.customerAdmin])
})

describe('GET /sites', () => {
    it("answers a Customer admin their Customer's Sites", () => {
        expect(get(listSites)).toEqual({ status: 200, body: { sites: [{ id: 'acme-hq', name: 'Acme HQ', customer: 'Acme' }] } })
    })
})

describe('GET /racks?site=', () => {
    const racksAt = (siteId: string) => get(listRacks, { query: { site: [siteId] } })

    it("answers the racks at a Site of the caller's Customer", () => {
        expect(racksAt('acme-hq')).toEqual({ status: 200, body: { racks: [{ id: 'rack-hq', name: 'HQ-1', room: 'Acme HQ' }] } })
    })

    it("answers 404 for another Customer's Site, as for a Site that does not exist", () => {
        expect(racksAt('globex-hq')).toEqual({ status: 404, body: { error: 'No such site' } })
        expect(racksAt('nowhere')).toEqual({ status: 404, body: { error: 'No such site' } })
    })

    it('answers 404 when no Site is named', () => {
        expect(get(listRacks)).toEqual({ status: 404, body: { error: 'No such site' } })
    })
})

describe('GET /racks/{id}', () => {
    const rack = (rackId: string) => get(getRack, { path: { id: rackId } })

    it("answers the elevation of a rack at a Site of the caller's Customer", () => {
        expect(rack('rack-hq')).toEqual({
            status: 200,
            body: { rack: { id: 'rack-hq', name: 'HQ-1', units: 42, power: { capacityW: 0, usedW: 0, utilisation: null } }, devices: [] },
        })
    })

    it("answers 404 for another Customer's rack, as for a rack that does not exist", () => {
        expect(rack('rack-globex')).toEqual({ status: 404, body: { error: 'No such rack' } })
        expect(rack('no-such-rack')).toEqual({ status: 404, body: { error: 'No such rack' } })
    })
})

describe('a caller who holds no role of the app', () => {
    it.each([
        ['GET /sites', () => get(listSites)],
        ['GET /racks?site=', () => get(listRacks, { query: { site: ['acme-hq'] } })],
        ['GET /racks/{id}', () => get(getRack, { path: { id: 'rack-hq' } })],
    ])('is answered 403 by %s', (_route, call) => {
        signIn(['itil'])

        expect(call()).toEqual({ status: 403, body: { error: 'Requires a NaaS role' } })
    })
})
```

**Verify**: `npx vitest run src/server/entry/racks.test.ts` → `Tests  9 passed (9)`.

### Step 4: Run the gate and commit

**Verify**:

- `npm run typecheck` → exit 0.
- `npm run lint` → exit 0.
- `npm run check` → exit 0, and the test total is 37 higher than before this plan (1841 if nothing else landed since `805d5da`, where it was 1804).
- `git status --short` → only the two new test files (and `plans/README.md` once you update it).

Then commit the two files.

## Test plan

Every test is in the two blocks above. The tables say what each one sets up beyond its file's shared
fixture and what it asserts, so that a failure can be reported by behaviour.

`platform/racks.test.ts`. Shared fixture: Customers `acme` (Acme) and `globex` (Globex). Sites
`acme-hq` and `acme-branch` of Acme and `globex-hq` of Globex. Two locations that are no Site:
`acme-room`, a Room whose parent is `acme-hq`, and `provider-dc`, a room of the Provider IT's.
Racks `rack-hq` (HQ-1, at `acme-hq`, 12 units, 1000 W), `rack-room` (HQ-2, in `acme-room`),
`rack-branch` (BR-1), `rack-globex` (GX-1) and `rack-dc` (DC-1, in `provider-dc`). One Model `m1`,
2 units high, 350 W. `signIn(role, company, contactOf)` signs in a new user and lists them as a
contact of the Sites in `contactOf`.

| Test | Signed in as | Asserts |
|---|---|---|
| Sites, Customer admin | admin of `acme` | `visibleSites()` is Acme Branch then Acme HQ, each with customer `Acme`. No Globex Site, no Room |
| Sites, site contact | contact of `acme`, listed at `acme-hq` | only Acme HQ |
| Sites, contact listed at another Customer's Site | contact of `acme`, listed at `acme-hq` and `globex-hq` | only Acme HQ |
| Sites, contact no Site lists | contact of `acme` | no Site |
| Sites, admin without a company | admin with company blank | no Site |
| Sites, staff (three cases) | asset manager, NOC, inventory tech | the three Sites by name, never `acme-room` or `provider-dc` |
| racks, Customer admin | admin of `acme` | `racksAtSite('acme-hq')` is HQ-1 (room Acme HQ) then HQ-2 (room Comms room) |
| racks, another Customer's Site | admin of `acme` | `racksAtSite('globex-hq')` is null |
| racks, contact not listed at the Site | contact of `acme`, listed at `acme-hq` | `acme-hq` gives HQ-1 and HQ-2. `acme-branch` gives null |
| racks, contact listed at another Customer's Site | contact of `acme`, listed at `globex-hq` | `globex-hq` gives null |
| racks, staff | NOC | `globex-hq` gives GX-1 |
| racks, not a Site (four cases) | asset manager | null for the Room `acme-room`, for `provider-dc`, for an id that names no location and for a blank id |
| racks, Site without racks | admin of `acme`, no rack stored | an empty list, not null |
| elevation, Customer admin | admin of `acme` | `rack-hq` gives the rack with 12 units and a power budget of 1000 W, 0 used, 0 percent. `rack-room` is given too |
| elevation, another Customer's rack | admin of `acme`, a Globex device in `rack-globex` | null |
| elevation, site contact | contact of `acme`, listed at `acme-hq` | `rack-hq` and `rack-room` given. `rack-branch` null |
| elevation, contact listed at another Customer's Site | contact of `acme`, listed at `globex-hq` | `rack-globex` null |
| elevation, no such rack (three cases) | asset manager | null for `rack-dc`, for an id that names no rack and for a blank id |
| elevation, rack at no location | asset manager, one rack with a blank location | null |
| elevation, devices | asset manager. In `rack-hq`: `a1` (rear, unit 1, with phase, coverage end and refresh date), `g1` of Globex (unit 5, its Model missing), `it1` outside the fleet, `a2` with no unit. In `rack-room`: `a3` | exactly `a1` and `g1`, each with every field of the contract. `g1` has model blank, height 1, face front. Power 350 W used of 1000, 35 percent |
| elevation, defaults | asset manager, `a3` in `rack-room` | 42 units, power capacity 0, 350 W used, utilisation null |

`entry/racks.test.ts`. Shared fixture: the two Customers, Sites `acme-hq` and `globex-hq`, racks
`rack-hq` and `rack-globex`, and a Customer admin of `acme` signed in. `get(handler, params)` calls
a route handler and returns the status and body it set.

| Test | Asserts |
|---|---|
| GET /sites | 200 with the one Site of Acme |
| GET /racks?site=, own Site | 200 with HQ-1 |
| GET /racks?site=, another Customer's Site | 404 `No such site`, the same answer as for a Site that does not exist |
| GET /racks?site=, no Site named | 404 `No such site` |
| GET /racks/{id}, own rack | 200 with the rack (42 units, no power budget) and no devices |
| GET /racks/{id}, another Customer's rack | 404 `No such rack`, the same answer as for a rack that does not exist |
| no role of the app (three cases) | a user holding only `itil` is answered 403 `Requires a NaaS role` by each of the three routes |

Structural patterns: `src/server/platform/customer-page.test.ts` and `src/server/entry/customer.test.ts`.

## Done criteria

All local. No instance is needed. ALL must hold:

- [ ] `npx vitest run src/server/platform/racks.test.ts` → 28 passed
- [ ] `npx vitest run src/server/entry/racks.test.ts` → 9 passed
- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm run check` exits 0
- [ ] `git show --stat --format= HEAD` lists the two test files and no other file (`plans/README.md` aside)
- [ ] `git status --short` shows no file outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- **A new test fails.** First compare your file with the block in this plan and copy it again if it differs. If it still fails, stop. Report the test's full name, and the expected and received values that vitest prints. Do not change the code under test, do not edit the assertion, do not skip the test, and do not commit. The tests passed at `805d5da`, so a failure means the behaviour changed since, and the owner must decide which is right. A test that expects `null` and receives a list is the most serious case: it means a user is shown a Site or a rack that is not theirs. Say so first in your report.
- A test throws an error that starts with `fake Glide:`. The fake does not model something the code now does. Changing `test-support/` is out of scope.
- The drift check shows a change in a file under test and the excerpts in "Current state" no longer match.
- `npm run typecheck` or `npm run lint` reports an error in one of the two new files after you copied it again from this plan.
- `npm run check` changes `src/fluent/generated/keys.ts`. This plan adds no metadata, so that change comes from somewhere else.
- A test file with either name already exists.

## Maintenance notes

- These are characterization tests. When the rack routes change on purpose, change the matching test in the same commit and say so in the commit body.
- The three platform functions trust the route's role guard. A user who holds no role of the app has scope `unscoped`, and `visibilityFilter` narrows nothing for that scope. `entry/racks.test.ts` pins the 403 that keeps such a user out. A new caller of `visibleSites`, `racksAtSite` or `rackElevation` must keep that guard.
- If `cmn_location` ever gets a before-query rule or an entry in `SCOPED_TABLES`, `LOCATION_SCOPING` and `seesSite` may go. These tests then say what the replacement must still do.
- Not covered, and why:
  - That a Customer sees only its own devices in a rack. The before-query rule on `alm_hardware` does that, and the fake runs no rule.
  - Role containment and the platform admin role. The fake's `gs.hasRole` knows the listed roles only.
  - The limit of 1000 Sites in `visibleSites`.
  - `placementRefusal` and the rack re-checks, which are the rack rules.
- Deferred: an ATF test that calls the three routes as a Customer admin and as a site contact of another Customer, in the style of the cross-tenant tests in `src/fluent/shared/visibility-tests.now.ts` (plan 012). It would also cover the device rule that the fake cannot. It needs an instance to mean anything.
- At planning time each of these changes to `racks.ts` made at least one of these tests fail: `seesSite` always true, `seesSite` without the user's filter, `seesSite` without the Site condition, `visibleSites` without the filter, scoping a site contact by Customer only, checking a rack's `location` and not its parent, and listing devices outside the fleet. A reviewer can repeat any of them.
- A reviewer should check that the commit holds the two test files and nothing else.
