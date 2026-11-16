# Plan 031: Test Ship and install confirmation on the fake Glide

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- src/server/platform/delivery.ts src/server/domain/delivery.ts src/server/domain/install-confirmation.ts src/server/platform/shipping.ts src/server/platform/field-work.ts src/server/platform/fulfilment.ts src/server/platform/assets.ts src/server/platform/returns.ts src/server/platform/locks.ts src/server/domain/lifecycle.ts src/server/test-support/fake-glide.ts src/server/test-support/encoded-query.ts src/server/platform/delivery.test.ts`
> The first twelve paths are the code under test and the fake it runs on.
> The last one is the file you create, and must not exist yet. If any of the
> twelve changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding. On a mismatch, treat it
> as a STOP condition. A change to `fake-glide.ts` that only adds a method
> (another plan adds one) is not a mismatch. A change to a file other than
> `delivery.ts` is not a mismatch either if the tests of this plan pass.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

Ship is the step that sends equipment to a Customer. `shipOrder` in
`src/server/platform/delivery.ts` takes a lock on the Order, may buy a carrier label, moves each
staged Asset to shipped, hands hot spares over, and opens a change request and a work order at the
Site. `confirmInstall` and `completeInstallOfWork` then record the install, which is what later
starts billing. Only the pure plan (`planShipment`) has unit tests, in
`src/server/domain/delivery.test.ts`. No test calls `shipOrder`, `confirmInstall` or
`completeInstallOfWork`. ATF reaches `confirmInstall` only through the refusals of the customer
route. So the lock, the re-check of each Asset after the label purchase, the on-site work that must
open once, and the reporting of a refused save are code nobody has run in a test. A mistake there
ships a unit twice, buys two labels, or opens two changes.

This plan adds 44 unit tests that pin what the code does today. It changes no behaviour. The tests
were written against commit `805d5da` and all pass there, so **a test that fails on the current
code is a finding to report, not a defect to fix in this plan**.

## Current state

Files and their roles:

- `src/server/platform/delivery.ts`. `shipOrder` ships an Order. `confirmInstall` records an install asked for from a form or the customer page. `completeInstallOfWork` records it when the on-site work order is closed. Not changed.
- `src/server/domain/delivery.ts`. `planShipment` decides what a Ship does. Already unit-tested.
- `src/server/platform/shipping.ts`. `labelOrder` buys the outbound label, `orderLabelBought` tells a bought label from a typed number. Not changed.
- `src/server/platform/field-work.ts`. `openFieldWork` inserts the change request and the work order. Not changed.
- `src/server/platform/fulfilment.ts`. `recomputeOrder` derives the Order's stage from its lines. Not changed.
- `src/server/test-support/fake-glide.ts`. The in-memory Glide the tests run on. Not changed.
- `src/server/platform/delivery.test.ts`. Does not exist. You create it.

Ship runs under a lock on the Order, from the Order read again there:

```ts
// src/server/platform/delivery.ts:81-88
export function shipOrder(orderId: string): ShipOutcome {
    const ship = withLock(LOCK.shipOrder(orderId), (lock) => {
        // A Ship that ran meanwhile has put its tracking number and work order on the Order, and shipped its units.
        const fresh = findById('x_daas_ham_order', orderId)
        return fresh ? shipHolding(lock, fresh) : notShipped('Order not found')
    })
    return ship.ran ? ship.value : notShipped('Another Ship of this Order is running: reload the Order to see what it shipped')
}
```

The label, then the move of each Asset still where Ship found it, then the on-site work:

```ts
// src/server/platform/delivery.ts:108-133
    if (plan.labelPackages !== null) {
        const label = labelOrder(order, plan.labelPackages, lock)
        if (!label.ok) return { problems: [...problems, `No shipping label: ${label.error}`], shipped: null }
        // The label is paid for and its Shipment saved, so the units still ship; only the Order lacks its tracking.
        if (label.orderRefusal) problems.push(`Tracking number ${label.trackingNumber} not saved on the Order: ${label.orderRefusal}`)
    }
    const hotSpares = new Set(found.hotSpares)
    const asset = new GlideRecord('alm_hardware')
    // Found past the visibility rules as shippable() found them; saved with every rule, so the line moves on.
    asset.addQuery('sys_id', 'IN', [...found.staged, ...found.hotSpares].join(','))
    beyondVisibility(asset, () => asset.query())
    let units = 0
    while (asset.next()) {
        // The label purchase takes time: an Asset moved on meanwhile is left alone.
        if (readStage(asset) !== (hotSpares.has(asset.getUniqueValue()) ? 'spare_pool' : 'staged')) continue
        placeAtSite(asset, siteId)
        // A hot spare is handed over where it is, as shipped: otherwise its line never gets past ready to ship.
        if (moveAndSave(asset, 'shipped', `ship ${str(order, 'number')}`)) units++
    }
    if (plan.onSiteWork) {
        const unopened = openOnSiteWork(order, plan.onSiteWork)
        if (unopened) problems.push(unopened)
    }
    recomputeOrder(order.getUniqueValue())
    return { problems, shipped: { units, siteName: str(order, 'site.name') } }
}
```

The on-site work is linked to the Order, and an unlinked one is opened again by the next Ship:

```ts
// src/server/platform/delivery.ts:171-177
    const opened = openFieldWork(context, work)
    if (!opened) return 'On-site work not opened (see the system log): open it by hand'
    order.setValue('change_request', opened.changeId)
    order.setValue('work_order', opened.workOrderId)
    // Unlinked, the next Ship opens the work again; the change and work order name the Order, to link them by hand.
    return order.update() ? null : `On-site work opened but not linked to the Order: ${refusal(order)}`
}
```

The install:

```ts
// src/server/platform/delivery.ts:187-192
export function confirmInstall(order: GlideRecord, confirmer: InstallConfirmer, saveForm: () => boolean = () => true): InstallConfirmation {
    const why = installRefusal(confirmer, installState(order))
    if (why) return { confirmed: false, why }
    if (!saveForm()) return { confirmed: false, why: 'unsaved' }
    return { confirmed: true, refused: completeInstall(order) }
}
```

```ts
// src/server/platform/delivery.ts:202-215
function completeInstall(order: GlideRecord): number {
    const now = nowGlide()
    const asset = orderAssets(order.getUniqueValue())
    let refused = 0
    while (asset.next()) {
        if (!awaitsInstall(readStage(asset))) continue
        asset.setValue('x_daas_ham_install_completed', now)
        asset.setValue('x_daas_ham_site', str(order, 'site'))
        if (!moveAndSave(asset, 'pending_in_service', `install ${str(order, 'number')}`)) refused++
    }
    retireReplacedAssets(order)
    recomputeOrder(order.getUniqueValue())
    return refused
}
```

```ts
// src/server/platform/delivery.ts:221-224
export function completeInstallOfWork(current: ForeignRecord): void {
    const order = findById('x_daas_ham_order', str(current, 'initiated_from'))
    if (order && installsOrder(str(current, 'x_daas_ham_purpose'))) completeInstall(order)
}
```

Facts the tests lean on, each read from the code at `805d5da`:

- The shipping aggregator is off unless the property `x_daas_ham.shipping.enabled` is `true` (`src/server/domain/properties.ts:36`, default `false`). With it off, a Ship of staged Assets needs a tracking number on the Order that no earlier Ship bought (`planShipment`, `src/server/domain/delivery.ts`). Most tests run that way, with the number typed by hand.
- An Asset may move to shipped only when it has a Site and an Agreement (`checkTransition`, `src/server/domain/lifecycle.ts:143-148`). Ship gives it the Order's Site. An Asset with no Agreement is refused with `An asset must belong to an agreement before it can be shipped`.
- A hot spare is an Asset of the Order's line in the Spare pool. Ship hands it over as shipped, without a package.
- On an instance an after rule on `alm_hardware` derives the line's stage each time an Asset of the line moves. The fake runs no rule, so line stages do not move in these tests. Two tests play that rule with `platform.onSave` to show that Ship and the install then move the Order on.
- The outbound call of a label purchase goes through `RESTMessageV2` (`src/server/platform/rest-messages.ts:11`). The test file replaces that class with `vi.mock('@servicenow/glide/sn_ws', ...)`, the pattern of `src/server/platform/oem-sync.test.ts:16-30`. No call leaves the machine.

What the fake needs set up. The fake holds any table once a row is seeded or inserted, so no table
is declared. The test file seeds or reads these tables: `alm_hardware`, `x_daas_ham_order`,
`x_daas_ham_order_line`, `x_daas_ham_shipment`, `change_request`, `wm_order`, `cmn_location`,
`core_company`, `alm_stockroom`, `x_daas_ham_job_lock`, `x_daas_ham_agreement`,
`x_daas_ham_return_order` and `x_daas_ham_return_order_line`. It declares:

- `platform.references`: `alm_hardware.x_daas_ham_order_line` to `x_daas_ham_order_line` (Ship queries `x_daas_ham_order_line.order`), `x_daas_ham_order.site` to `cmn_location` (Ship reads `site.name`), and `x_daas_ham_order.customer` to `core_company` (the label's recipient company).
- `platform.uniqueKeys`: `x_daas_ham_job_lock` by `name`, which is how a job lock is held (ADR 0013). A test holds a lock by storing its row.
- `platform.defaults`: a number for `change_request`, `wm_order` and `x_daas_ham_return_order`, and status `awaiting` for a Return order line, as the platform fills them in on insert.

Conventions that apply (from `AGENTS.md` and `README.md` "Development"):

- A test is a `*.test.ts` file beside the module it tests. The build leaves it out of the app.
- A relative import in `src/server` names the `.ts` file (`'./delivery.ts'`, not `'./delivery'`).
- A test of `platform/` runs against `test-support/fake-glide.ts`. Each test file mocks Glide with this exact line, after its imports:
  `vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)`
- Use the words of `CONTEXT.md` in test names: Order, Asset, Site, Customer, hot spare, Return order.
- Model the structure on `src/server/platform/returns.test.ts` and `src/server/platform/disposal.test.ts`.

What the tests rely on in the fake (`src/server/test-support/fake-glide.ts`):

- `platform.reset()` clears everything. `platform.tables[table]` holds the stored rows, and a test seeds and reads them directly.
- A field that was never set to a non-blank value is absent from the stored row. That is why some assertions read `row.field ?? ''`.
- `update()` saves only when a field changed.
- `platform.refuses(table, row, operation)` returns why a save is refused. `platform.onSave(table, row, operation)` runs just before a row is stored, and a test uses it to land "another transaction's" write at that moment.
- `platform.logs` holds each log line as `<level> <message>`. `platform.warnings` holds the warnings without the level.
- A dot-walk through a reference the test did not declare in `platform.references` throws an error that starts with `fake Glide:`.
- The fake runs no business rule, ACL or flow.

No secret is needed. The aggregator's API key is a password2 property that the tests leave unset,
and the stub ignores it. Do not put a real key, token or carrier account in the test file.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| The test file | `npx vitest run src/server/platform/delivery.test.ts` | all pass |
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

- `src/server/platform/delivery.test.ts` (create)
- `plans/README.md` (your status row only)

**Out of scope** (do NOT touch):

- `src/server/platform/delivery.ts` and every other non-test file. This plan changes no behaviour, even where a test shows behaviour you think is wrong.
- `src/server/test-support/fake-glide.ts`. The tests need nothing the fake lacks. If one throws `fake Glide:`, stop.
- `src/server/entry/delivery.ts` (`uiShipOrder`, `uiConfirmInstalled`). They turn the outcomes tested here into messages and are not tested by this plan.
- `src/server/platform/shipping.ts`. Plan 030 tests it. This plan reaches `labelOrder` only through `shipOrder`.
- ATF tests of Ship.

## Git workflow

- Branch: `advisor/031-ship-order-tests`
- One commit. Subject in the repo's style (an imperative sentence under 72 characters), for example:
  `Test Ship and install confirmation`
  The body says that no test called `shipOrder`, `confirmInstall` or `completeInstallOfWork`, and that the tests pin the behaviour as it is at `805d5da`.
- Do NOT push or open a PR unless the operator told you to.

## Steps

### Step 1: Record the baseline

**Verify**: `npx vitest run src/server/platform src/server/domain/delivery.test.ts` → all pass. `ls src/server/platform/delivery.test.ts` → "No such file".

### Step 2: Create the tests

Create `src/server/platform/delivery.test.ts` with exactly this content:

```ts
import { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fieldsOf, type Stage } from '../domain/lifecycle.ts'
import { LOCK } from '../domain/lock-names.ts'
import { PROPERTY } from '../domain/properties.ts'
import { completeInstallOfWork, confirmInstall, shipOrder } from './delivery.ts'
import type { ForeignRecord } from './records.ts'
import { platform, recordOf, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

/** What the shipping aggregator is sent, and what it answers each call. */
const aggregator = { sent: [] as string[], answer: { status: 200, body: '' } }

vi.mock('@servicenow/glide/sn_ws', () => ({
    RESTMessageV2: class {
        private body = ''
        setStringParameterNoEscape(): void {}
        setRequestHeader(): void {}
        setRequestBody(body: string): void {
            this.body = body
        }
        execute() {
            aggregator.sent.push(this.body)
            return { getStatusCode: () => aggregator.answer.status, getBody: () => aggregator.answer.body, getErrorMessage: () => '' }
        }
    },
}))

const ASSETS = 'alm_hardware'
const ORDERS = 'x_daas_ham_order'
const LINES = 'x_daas_ham_order_line'
const SHIPMENTS = 'x_daas_ham_shipment'
const CHANGES = 'change_request'
const WORK_ORDERS = 'wm_order'
const RETURNS = 'x_daas_ham_return_order'
const RETURN_LINES = 'x_daas_ham_return_order_line'
const LOCKS = 'x_daas_ham_job_lock'

const rows = (table: string): Row[] => platform.tables[table] ?? []
const asset = (id: string): Row => rows(ASSETS).find((row) => row.sys_id === id) ?? {}
const order = (): Row => rows(ORDERS)[0] ?? {}

function stage(of: Stage): Row {
    const { installStatus, substatus } = fieldsOf(of)
    return { install_status: installStatus, substatus: substatus ?? '' }
}

/** A fleet asset of the Order's line `ol1`, under the Customer's Agreement. */
function unit(id: string, of: Stage, fields: Row = {}): Row {
    return { sys_id: id, serial_number: `FOC-${id}`, x_daas_ham_fleet: 'true', x_daas_ham_agreement: 'ag1', x_daas_ham_order_line: 'ol1', ...stage(of), ...fields }
}

function orderRecord(): GlideRecord {
    const found = new GlideRecord(ORDERS)
    found.get('o1')
    return found
}

beforeEach(() => {
    platform.reset()
    aggregator.sent.length = 0
    aggregator.answer = { status: 200, body: '' }
    platform.clock = Date.parse('2026-11-10T09:00:00Z')
    platform.uniqueKeys = { [LOCKS]: 'name' }
    platform.references = {
        [`${ASSETS}.x_daas_ham_order_line`]: LINES,
        [`${ORDERS}.site`]: 'cmn_location',
        [`${ORDERS}.customer`]: 'core_company',
    }
    platform.defaults = { [CHANGES]: () => ({ number: 'CHG0001' }), [WORK_ORDERS]: () => ({ number: 'WO0001' }) }
    platform.tables[LOCKS] = []
    platform.tables.core_company = [{ sys_id: 'acme', name: 'Acme' }]
    platform.tables.cmn_location = [
        { sys_id: 'site1', name: 'Acme HQ', street: 'Storgata 1', city: 'Bergen', zip: '5003', country: 'NO', phone: '+47 55 00 00 00' },
        { sys_id: 'depot-location', name: 'Depot', street: 'Havnegata 2', city: 'Oslo', zip: '0150', country: 'NO' },
    ]
    platform.tables.alm_stockroom = [{ sys_id: 'depot', name: 'Central depot', location: 'depot-location' }]
    platform.tables[ORDERS] = [
        {
            sys_id: 'o1',
            number: 'ORD0001',
            customer: 'acme',
            site: 'site1',
            agreement: 'ag1',
            order_type: 'site_rollout',
            install_mode: 'fsm_engineer',
            stage: 'delivering',
            carrier: 'ups',
            tracking_number: 'TYPED-BY-HAND',
        },
    ]
    platform.tables[LINES] = [{ sys_id: 'ol1', number: 'OL0001', order: 'o1', line_stage: 'ready_to_ship', quantity: '2' }]
    platform.tables[ASSETS] = [unit('a1', 'staged'), unit('a2', 'staged')]
    platform.tables[SHIPMENTS] = []
    platform.tables[CHANGES] = []
    platform.tables[WORK_ORDERS] = []
})

describe('Ship, with the tracking number typed on the Order', () => {
    it('moves the staged Assets to shipped at the Site, and opens the on-site work and links it to the Order', () => {
        expect(shipOrder('o1')).toEqual({ problems: [], shipped: { units: 2, siteName: 'Acme HQ' } })

        expect(asset('a1')).toMatchObject({ ...stage('shipped'), x_daas_ham_site: 'site1', location: 'site1' })
        expect(asset('a2')).toMatchObject({ ...stage('shipped'), x_daas_ham_site: 'site1', location: 'site1' })
        expect(rows(CHANGES)).toEqual([
            expect.objectContaining({ type: 'normal', parent: 'o1', short_description: 'ORD0001: site_rollout at Acme HQ', company: 'acme', location: 'site1' }),
        ])
        expect(rows(WORK_ORDERS)).toEqual([
            expect.objectContaining({
                x_daas_ham_purpose: 'install',
                initiated_from: 'o1',
                parent: rows(CHANGES)[0]?.sys_id,
                short_description: 'ORD0001: site_rollout at Acme HQ',
                company: 'acme',
                location: 'site1',
            }),
        ])
        expect(rows(WORK_ORDERS)[0]?.work_notes ?? '').toBe('')
        expect(order()).toMatchObject({ change_request: rows(CHANGES)[0]?.sys_id, work_order: rows(WORK_ORDERS)[0]?.sys_id, tracking_number: 'TYPED-BY-HAND' })
        expect(aggregator.sent).toEqual([])
        expect(rows(SHIPMENTS)).toEqual([])
        expect(rows(LOCKS)).toEqual([])
        expect(platform.logs).toEqual([])
    })

    it('opens the on-site work once: a second Ship, of Assets staged since, opens none', () => {
        shipOrder('o1')
        rows(ASSETS).push(unit('a3', 'staged'))

        expect(shipOrder('o1')).toEqual({ problems: [], shipped: { units: 1, siteName: 'Acme HQ' } })

        expect(asset('a3')).toMatchObject(stage('shipped'))
        expect(rows(CHANGES)).toHaveLength(1)
        expect(rows(WORK_ORDERS)).toHaveLength(1)
    })

    it('moves the Order on to what its lines say once the units are shipped', () => {
        // The after rule on alm_hardware derives a line's stage from its Assets. The fake runs no rule, so the test does.
        platform.onSave = (table, row) => {
            if (table === ASSETS && row.install_status === stage('shipped').install_status) Object.assign(rows(LINES)[0] ?? {}, { line_stage: 'shipped' })
        }

        shipOrder('o1')

        expect(order().stage).toBe('installing')
    })

    it.each([
        ['device_replace', 'fsm_engineer', { type: 'standard' }, { x_daas_ham_purpose: 'swap' }],
        ['refresh', 'fsm_engineer', { type: 'normal' }, { x_daas_ham_purpose: 'swap' }],
        ['device_add', 'subcontractor', { type: 'normal' }, { x_daas_ham_purpose: 'install', work_notes: 'Dispatch to subcontractor / remote hands.' }],
    ])('opens the work a %s Order installed by %s needs', (orderType, installMode, change, workOrder) => {
        Object.assign(order(), { order_type: orderType, install_mode: installMode })

        shipOrder('o1')

        expect(rows(CHANGES)).toEqual([expect.objectContaining(change)])
        expect(rows(WORK_ORDERS)).toEqual([expect.objectContaining(workOrder)])
    })

    it('opens no on-site work for a self-install', () => {
        order().install_mode = 'self_install'

        expect(shipOrder('o1')).toEqual({ problems: [], shipped: { units: 2, siteName: 'Acme HQ' } })

        expect(rows(CHANGES)).toEqual([])
        expect(rows(WORK_ORDERS)).toEqual([])
        expect(order().work_order ?? '').toBe('')
    })

    it('hands a hot spare over as shipped, with the staged Assets', () => {
        rows(ASSETS).push(unit('h1', 'spare_pool'))

        expect(shipOrder('o1')).toEqual({ problems: [], shipped: { units: 3, siteName: 'Acme HQ' } })

        expect(asset('h1')).toMatchObject({ ...stage('shipped'), x_daas_ham_site: 'site1', location: 'site1' })
    })

    it('leaves the Assets of another Order, and those of this one in another stage, where they are', () => {
        platform.tables[LINES].push({ sys_id: 'ol9', order: 'o9', line_stage: 'ready_to_ship', quantity: '1' })
        rows(ASSETS).push(unit('other', 'staged', { x_daas_ham_order_line: 'ol9' }), unit('a3', 'staging'), unit('a4', 'pending_in_service', { x_daas_ham_site: 'site1' }))

        expect(shipOrder('o1').shipped).toEqual({ units: 2, siteName: 'Acme HQ' })

        expect(asset('other')).toMatchObject(stage('staged'))
        expect(asset('other').x_daas_ham_site ?? '').toBe('')
        expect(asset('a3')).toMatchObject(stage('staging'))
        expect(asset('a4')).toMatchObject(stage('pending_in_service'))
    })
})

describe('a Ship that sends nothing', () => {
    function nothingShipped(): void {
        expect(asset('a1')).toMatchObject(stage('staged'))
        expect(asset('a1').x_daas_ham_site ?? '').toBe('')
        expect(rows(CHANGES)).toEqual([])
        expect(rows(WORK_ORDERS)).toEqual([])
        expect(rows(LOCKS).filter((lock) => lock.sys_id !== 'held')).toEqual([])
    }

    it("says another Ship is running while one holds the Order's Ship lock", () => {
        rows(LOCKS).push({ sys_id: 'held', name: LOCK.shipOrder('o1'), sys_created_on: '2026-11-10 09:00:00' })

        expect(shipOrder('o1')).toEqual({ problems: ['Another Ship of this Order is running: reload the Order to see what it shipped'], shipped: null })

        nothingShipped()
    })

    it('asks for the carrier and tracking number when the Order has none and the aggregator is off', () => {
        Object.assign(order(), { carrier: '', tracking_number: '' })

        expect(shipOrder('o1')).toEqual({ problems: ['Enter the carrier and tracking number before shipping'], shipped: null })

        nothingShipped()
    })

    it('asks for them again when the tracking number is a label an earlier Ship bought', () => {
        rows(SHIPMENTS).push({ sys_id: 'shp1', direction: 'to_site', order: 'o1', tracking_number: 'TYPED-BY-HAND', status: 'in_transit' })

        expect(shipOrder('o1')).toEqual({ problems: ['Enter the carrier and tracking number before shipping'], shipped: null })

        nothingShipped()
    })

    it('says nothing is staged when the Order has no staged Asset and no hot spare', () => {
        platform.tables[ASSETS] = [unit('a1', 'staging')]

        expect(shipOrder('o1')).toEqual({ problems: ['Nothing is staged for this order yet'], shipped: null })
    })

    it('says so when the Order is gone', () => {
        expect(shipOrder('no-such-order')).toEqual({ problems: ['Order not found'], shipped: null })

        expect(rows(LOCKS)).toEqual([])
    })

    it('says why when the lifecycle lets none of its Assets ship', () => {
        platform.tables[ASSETS] = [unit('a1', 'staged', { x_daas_ham_agreement: '' })]

        expect(shipOrder('o1')).toEqual({ problems: ['1 asset(s) cannot ship: An asset must belong to an agreement before it can be shipped'], shipped: null })

        nothingShipped()
    })
})

describe('a Ship that sends part of the Order', () => {
    it('ships the Assets the lifecycle lets ship, and reports the others', () => {
        asset('a2').x_daas_ham_agreement = ''

        expect(shipOrder('o1')).toEqual({
            problems: ['1 asset(s) cannot ship: An asset must belong to an agreement before it can be shipped'],
            shipped: { units: 1, siteName: 'Acme HQ' },
        })

        expect(asset('a1')).toMatchObject(stage('shipped'))
        expect(asset('a2')).toMatchObject(stage('staged'))
        expect(asset('a2').x_daas_ham_site ?? '').toBe('')
        expect(rows(WORK_ORDERS)).toHaveLength(1)
    })

    it('does not count an Asset the platform refuses to save as shipped, and logs it', () => {
        platform.refuses = (table, row) => (table === ASSETS && row.sys_id === 'a2' ? 'stage rule said no' : '')

        expect(shipOrder('o1')).toEqual({ problems: [], shipped: { units: 1, siteName: 'Acme HQ' } })

        expect(asset('a1')).toMatchObject(stage('shipped'))
        expect(asset('a2')).toMatchObject(stage('staged'))
        expect(platform.warnings).toEqual([expect.stringContaining('ship ORD0001: FOC-a2 not moved to shipped: stage rule said no')])
    })

    it('ships a hot spare without a carrier: it is at the Site already', () => {
        Object.assign(order(), { carrier: '', tracking_number: '' })
        platform.tables[ASSETS] = [unit('h1', 'spare_pool')]

        expect(shipOrder('o1')).toEqual({ problems: [], shipped: { units: 1, siteName: 'Acme HQ' } })

        expect(asset('h1')).toMatchObject(stage('shipped'))
    })

    it('ships to data-centre remote hands without a carrier', () => {
        Object.assign(order(), { carrier: '', tracking_number: '', install_mode: 'remote_hands' })

        expect(shipOrder('o1')).toEqual({ problems: [], shipped: { units: 2, siteName: 'Acme HQ' } })

        expect(rows(WORK_ORDERS)).toEqual([expect.objectContaining({ work_notes: 'Dispatch to subcontractor / remote hands.' })])
    })
})

describe('on-site work the platform refuses', () => {
    const UNOPENED = 'On-site work not opened (see the system log): open it by hand'

    it('is reported when the change is refused, the units shipped all the same', () => {
        platform.refuses = (table) => (table === CHANGES ? 'change freeze' : '')

        expect(shipOrder('o1')).toEqual({ problems: [UNOPENED], shipped: { units: 2, siteName: 'Acme HQ' } })

        expect(asset('a1')).toMatchObject(stage('shipped'))
        expect(rows(WORK_ORDERS)).toEqual([])
        expect(order().work_order ?? '').toBe('')
        expect(platform.warnings).toEqual([expect.stringContaining('No change for ORD0001: site_rollout at Acme HQ: change freeze')])
    })

    it('is reported when the work order is refused, and its change is named to be cancelled', () => {
        platform.refuses = (table) => (table === WORK_ORDERS ? 'no dispatch group' : '')

        expect(shipOrder('o1')).toEqual({ problems: [UNOPENED], shipped: { units: 2, siteName: 'Acme HQ' } })

        expect(rows(CHANGES)).toHaveLength(1)
        expect(order().change_request ?? '').toBe('')
        expect(platform.warnings).toEqual([expect.stringContaining('No work order for ORD0001: site_rollout at Acme HQ (CHG0001 has none, cancel it): no dispatch group')])
    })

    it('is reported as not linked when the Order is refused, and the next Ship opens it again', () => {
        platform.refuses = (table) => (table === ORDERS ? 'order is read only' : '')

        expect(shipOrder('o1')).toEqual({
            problems: ['On-site work opened but not linked to the Order: order is read only'],
            shipped: { units: 2, siteName: 'Acme HQ' },
        })

        expect(rows(WORK_ORDERS)).toHaveLength(1)
        expect(order().work_order ?? '').toBe('')

        platform.refuses = () => ''
        rows(ASSETS).push(unit('a3', 'staged'))
        shipOrder('o1')

        expect(rows(WORK_ORDERS)).toHaveLength(2)
        expect(order().work_order).toBe(rows(WORK_ORDERS)[1]?.sys_id)
    })
})

describe('Ship, with the shipping aggregator on', () => {
    const LABEL = JSON.stringify({ label_id: 'se-456', tracking_number: '1ZNEW02', carrier_code: 'ups', label_download: { pdf: 'https://labels.example/se-456.pdf' }, shipment_cost: { amount: 30, currency: 'NOK' } })

    beforeEach(() => {
        aggregator.answer = { status: 200, body: LABEL }
        platform.properties = {
            [PROPERTY.shippingEnabled.name]: 'true',
            [PROPERTY.shippingCarrierId.name]: 'se-carrier',
            [PROPERTY.stagingStockroom.name]: 'depot',
            [PROPERTY.shippingSenderPhone.name]: '+47 22 00 00 00',
        }
        Object.assign(order(), { carrier: '', tracking_number: '' })
    })

    it('buys one label, a box per staged Asset, saves its tracking number on the Order and ships the Assets', () => {
        rows(ASSETS).push(unit('h1', 'spare_pool'))

        expect(shipOrder('o1')).toEqual({ problems: [], shipped: { units: 3, siteName: 'Acme HQ' } })

        expect(aggregator.sent).toHaveLength(1)
        expect((JSON.parse(aggregator.sent[0] ?? '{}') as { shipment: { packages: unknown[] } }).shipment.packages).toHaveLength(2)
        expect(rows(SHIPMENTS)).toEqual([expect.objectContaining({ direction: 'to_site', order: 'o1', packages: '2', tracking_number: '1ZNEW02', status: 'label_created' })])
        expect(order()).toMatchObject({ carrier: 'ups', tracking_number: '1ZNEW02' })
        expect(asset('a1')).toMatchObject(stage('shipped'))
        expect(rows(LOCKS)).toEqual([])
    })

    it('buys a new label for Assets staged after an earlier Ship bought one', () => {
        shipOrder('o1')
        rows(ASSETS).push(unit('a3', 'staged'))
        aggregator.answer = { status: 200, body: LABEL.replace('1ZNEW02', '1ZNEW03') }

        expect(shipOrder('o1')).toEqual({ problems: [], shipped: { units: 1, siteName: 'Acme HQ' } })

        expect(rows(SHIPMENTS).map((shipment) => [shipment.tracking_number, shipment.packages])).toEqual([
            ['1ZNEW02', '2'],
            ['1ZNEW03', '1'],
        ])
        expect(order().tracking_number).toBe('1ZNEW03')
    })

    it('buys none when the tracking number was typed by hand', () => {
        Object.assign(order(), { carrier: 'dhl', tracking_number: 'TYPED-BY-HAND' })

        expect(shipOrder('o1')).toEqual({ problems: [], shipped: { units: 2, siteName: 'Acme HQ' } })

        expect(aggregator.sent).toEqual([])
        expect(order().tracking_number).toBe('TYPED-BY-HAND')
    })

    it('ships nothing, and opens no work, when no label is bought', () => {
        aggregator.answer = { status: 400, body: JSON.stringify({ errors: [{ message: 'carrier account suspended' }] }) }

        expect(shipOrder('o1')).toEqual({ problems: ['No shipping label: HTTP 400: carrier account suspended'], shipped: null })

        expect(asset('a1')).toMatchObject(stage('staged'))
        expect(rows(SHIPMENTS)).toEqual([])
        expect(rows(WORK_ORDERS)).toEqual([])
    })

    it('leaves alone an Asset that moved on while the label was bought', () => {
        // Another transaction puts a2 in the Spare pool as the label's Shipment is saved.
        platform.onSave = (table) => {
            if (table === SHIPMENTS) Object.assign(asset('a2'), stage('spare_pool'))
        }

        expect(shipOrder('o1')).toEqual({ problems: [], shipped: { units: 1, siteName: 'Acme HQ' } })

        expect(asset('a1')).toMatchObject(stage('shipped'))
        expect(asset('a2')).toMatchObject(stage('spare_pool'))
        expect(asset('a2').x_daas_ham_site ?? '').toBe('')
        expect(platform.logs).toEqual([])
    })

    it('ships the units, and reports each save of the Order the platform refuses', () => {
        platform.refuses = (table) => (table === ORDERS ? 'order is read only' : '')

        expect(shipOrder('o1')).toEqual({
            problems: ['Tracking number 1ZNEW02 not saved on the Order: order is read only', 'On-site work opened but not linked to the Order: order is read only'],
            shipped: { units: 2, siteName: 'Acme HQ' },
        })

        expect(rows(SHIPMENTS)).toHaveLength(1)
        expect(order().tracking_number).toBe('')
        expect(asset('a1')).toMatchObject(stage('shipped'))
        expect(asset('a2')).toMatchObject(stage('shipped'))
    })
})

describe('confirming an install', () => {
    beforeEach(() => {
        order().stage = 'installing'
        platform.tables[ASSETS] = [unit('a1', 'shipped', { x_daas_ham_site: 'site1' }), unit('a2', 'shipped', { x_daas_ham_site: 'site1' })]
    })

    const INSTALLED = { ...stage('pending_in_service'), x_daas_ham_install_completed: '2026-11-10 09:00:00', x_daas_ham_site: 'site1' }

    it("moves the shipped units to pending in service, stamped with the time and the Order's Site", () => {
        asset('a2').x_daas_ham_site = 'old-site'

        expect(confirmInstall(orderRecord(), 'staff')).toEqual({ confirmed: true, refused: 0 })

        expect(asset('a1')).toMatchObject(INSTALLED)
        expect(asset('a2')).toMatchObject(INSTALLED)
        expect(platform.logs).toEqual([])
    })

    it('moves only the shipped units of an Order held back by a line filled again', () => {
        order().stage = 'delivering'
        rows(ASSETS).push(unit('a3', 'staged'), unit('h1', 'spare_pool'))

        expect(confirmInstall(orderRecord(), 'staff')).toEqual({ confirmed: true, refused: 0 })

        expect(asset('a1')).toMatchObject(INSTALLED)
        expect(asset('a3')).toMatchObject(stage('staged'))
        expect(asset('h1')).toMatchObject(stage('spare_pool'))
    })

    it('counts a unit the platform refuses to move, which stays shipped, and logs it', () => {
        platform.refuses = (table, row) => (table === ASSETS && row.sys_id === 'a2' ? 'stage rule said no' : '')

        expect(confirmInstall(orderRecord(), 'staff')).toEqual({ confirmed: true, refused: 1 })

        expect(asset('a1')).toMatchObject(INSTALLED)
        expect(asset('a2')).toMatchObject(stage('shipped'))
        expect(asset('a2').x_daas_ham_install_completed ?? '').toBe('')
        expect(platform.warnings).toEqual([expect.stringContaining('install ORD0001: FOC-a2 not moved to pending_in_service: stage rule said no')])
    })

    it('is refused when nothing waits to be installed', () => {
        order().stage = 'preparing'
        platform.tables[ASSETS] = [unit('a1', 'staged')]

        expect(confirmInstall(orderRecord(), 'staff')).toEqual({ confirmed: false, why: 'nothing_waiting' })

        expect(asset('a1')).toMatchObject(stage('staged'))
    })

    it("is the Customer's to give for a self-install only", () => {
        expect(confirmInstall(orderRecord(), 'customer')).toEqual({ confirmed: false, why: 'not_self_install' })
        expect(asset('a1')).toMatchObject(stage('shipped'))

        order().install_mode = 'self_install'

        expect(confirmInstall(orderRecord(), 'customer')).toEqual({ confirmed: true, refused: 0 })
        expect(asset('a1')).toMatchObject(INSTALLED)
    })

    it('records nothing when the form it was asked from is not saved', () => {
        expect(confirmInstall(orderRecord(), 'staff', () => false)).toEqual({ confirmed: false, why: 'unsaved' })

        expect(asset('a1')).toMatchObject(stage('shipped'))
    })

    it('moves the Order on to what its lines say', () => {
        // The after rule on alm_hardware derives a line's stage from its Assets. The fake runs no rule, so the test does.
        platform.onSave = (table) => {
            if (table === ASSETS) Object.assign(rows(LINES)[0] ?? {}, { line_stage: 'in_service' })
        }

        confirmInstall(orderRecord(), 'staff')

        expect(order()).toMatchObject({ stage: 'complete' })
    })
})

describe('an install that replaces an Asset', () => {
    beforeEach(() => {
        platform.defaults = { ...platform.defaults, [RETURNS]: () => ({ number: 'RET0001' }), [RETURN_LINES]: () => ({ status: 'awaiting' }) }
        platform.tables.x_daas_ham_agreement = [{ sys_id: 'ag1', overdue_return_days: '10' }]
        Object.assign(order(), { stage: 'installing', order_type: 'device_replace' })
        Object.assign(rows(LINES)[0] ?? {}, { line_stage: 'shipped', quantity: '1', replaces_asset: 'old1' })
        platform.tables[ASSETS] = [
            unit('a1', 'shipped', { x_daas_ham_site: 'site1' }),
            unit('old1', 'in_service', { x_daas_ham_order_line: '', x_daas_ham_site: 'site1', company: 'acme' }),
        ]
    })

    it('puts the Asset replaced on a Return order from the Order once its replacement is installed', () => {
        expect(confirmInstall(orderRecord(), 'staff')).toEqual({ confirmed: true, refused: 0 })

        expect(rows(RETURNS)).toEqual([expect.objectContaining({ number: 'RET0001', customer: 'acme', site: 'site1' })])
        expect(rows(RETURN_LINES).map((line) => [line.return_order, line.asset])).toEqual([[rows(RETURNS)[0]?.sys_id, 'old1']])
    })

    it('leaves the Asset replaced in service while its replacement is still shipped', () => {
        platform.refuses = (table, row) => (table === ASSETS && row.sys_id === 'a1' ? 'stage rule said no' : '')

        expect(confirmInstall(orderRecord(), 'staff')).toEqual({ confirmed: true, refused: 1 })

        expect(rows(RETURNS)).toEqual([])
        expect(asset('old1')).toMatchObject(stage('in_service'))
    })
})

describe('a work order closed complete', () => {
    const closed = (fields: Row): ForeignRecord => recordOf<ForeignRecord>(WORK_ORDERS, { sys_id: 'wo1', initiated_from: 'o1', x_daas_ham_purpose: 'install', ...fields })

    beforeEach(() => {
        order().stage = 'installing'
        platform.tables[ASSETS] = [unit('a1', 'shipped', { x_daas_ham_site: 'site1' })]
    })

    it.each(['install', 'swap'])('completes the install of the Order it was initiated from when its purpose is %s', (purpose) => {
        completeInstallOfWork(closed({ x_daas_ham_purpose: purpose }))

        expect(asset('a1')).toMatchObject({ ...stage('pending_in_service'), x_daas_ham_install_completed: '2026-11-10 09:00:00' })
    })

    it.each([
        ['a de-install job', { x_daas_ham_purpose: 'de_install' }],
        ['a site audit', { x_daas_ham_purpose: 'site_audit' }],
        ['work with no purpose', { x_daas_ham_purpose: '' }],
        ['work initiated from no Order', { initiated_from: '' }],
        ['work initiated from another record', { initiated_from: 'ret1' }],
    ])('completes nothing for %s', (_what, fields) => {
        completeInstallOfWork(closed(fields))

        expect(asset('a1')).toMatchObject(stage('shipped'))
    })
})
```

**Verify**: `npx vitest run src/server/platform/delivery.test.ts` → `Tests  44 passed (44)`.

### Step 3: Run the gate and commit

**Verify**:

- `npm run typecheck` → exit 0.
- `npm run lint` → exit 0.
- `npm run check` → exit 0, and the test total is 44 higher than before this plan (1848 if nothing else landed since `805d5da`, where it was 1804).
- `git status --short` → only the new test file (and `plans/README.md` once you update it).

Then commit the file.

## Test plan

Every test is in the block above. The tables say what each one sets up beyond the shared fixture
and what it asserts, so that a failure can be reported by behaviour.

Shared fixture: the clock at 2026-11-10 09:00 UTC. Customer `acme`, Site `site1` (Acme HQ) and the
depot. Order `ORD0001` (`o1`): a site rollout installed by a Provider field engineer, at stage
delivering, with carrier `ups` and tracking number `TYPED-BY-HAND`. One line `ol1`, ready to ship.
Two fleet assets `a1` and `a2` of that line, staged, under Agreement `ag1`. The aggregator is off.
`unit(id, stage, fields)` builds an Asset of the line.

Ship with a typed tracking number (9 tests):

| Test | Setup | Asserts |
|---|---|---|
| ships and opens the work | none | `{ problems: [], shipped: { units: 2, siteName: 'Acme HQ' } }`. Both Assets shipped with Site and location `site1`. One change (type normal, parent the Order, described `ORD0001: site_rollout at Acme HQ`, company and location set). One work order (purpose install, initiated from the Order, parent the change, no dispatch note). The Order names both and keeps its tracking number. Nothing sent to the aggregator, no Shipment, no lock row left, nothing logged |
| work opened once | a first Ship, then a third Asset staged and a second Ship | 1 unit shipped, still one change and one work order |
| Order moves on | the test plays the after rule: the line becomes shipped as its Asset is saved | the Order's stage is installing |
| work by Order type and install mode (three cases) | device replace by field engineer. Refresh by field engineer. Device add by subcontractor | change standard and purpose swap. Change normal and purpose swap. Change normal, purpose install, work note `Dispatch to subcontractor / remote hands.` |
| self-install | install mode self-install | 2 units shipped, no change, no work order, the Order names none |
| hot spare | a third Asset of the line in the Spare pool | 3 units shipped, the hot spare shipped at `site1` |
| other Assets left alone | a staged Asset of another Order, and Assets of this Order in staging and pending in service | 2 units shipped, the three others unchanged |

A Ship that sends nothing (6 tests). Each asserts `shipped: null`:

| Test | Setup | Asserts |
|---|---|---|
| Ship lock held | a lock row named `LOCK.shipOrder('o1')` | problem `Another Ship of this Order is running: reload the Order to see what it shipped`. `a1` staged with no Site, no work opened |
| no tracking number | carrier and tracking number blank | problem `Enter the carrier and tracking number before shipping`. Nothing moved, no work opened |
| tracking number bought earlier | a Shipment of the Order with the Order's tracking number | the same problem |
| nothing staged | the only Asset is in staging | problem `Nothing is staged for this order yet` |
| Order gone | an id no Order has | problem `Order not found`, no lock row left |
| every Asset refused | the only Asset has no Agreement | problem `1 asset(s) cannot ship: An asset must belong to an agreement before it can be shipped`. Nothing moved |

A Ship that sends part of the Order (4 tests):

| Test | Setup | Asserts |
|---|---|---|
| one Asset refused by the lifecycle | `a2` has no Agreement | the refusal as a problem and 1 unit shipped. `a1` shipped, `a2` staged with no Site, one work order |
| one save refused | update of `a2` refused | no problem, 1 unit shipped, `a2` staged, one warning `ship ORD0001: FOC-a2 not moved to shipped: stage rule said no` |
| hot spare alone | no tracking number, only a hot spare | 1 unit shipped |
| remote hands | no tracking number, install mode remote hands | 2 units shipped, work order with the dispatch note |

On-site work the platform refuses (3 tests). Each ships both units:

| Test | Setup | Asserts |
|---|---|---|
| change refused | insert into `change_request` refused | problem `On-site work not opened (see the system log): open it by hand`. No work order, the Order names none, one warning `No change for ...` |
| work order refused | insert into `wm_order` refused | the same problem. The change exists, the Order does not name it, one warning naming `CHG0001` to cancel |
| link refused | update of the Order refused | problem `On-site work opened but not linked to the Order: order is read only`. One work order, the Order names none. Refusal lifted, a third Asset staged and shipped: a second work order, which the Order names |

Ship with the aggregator on (6 tests). Extra fixture: the properties that turn the aggregator on
and name the carrier account, the depot and the sender phone. The Order has no tracking number.
The aggregator answers 200 with label `se-456` and tracking number `1ZNEW02`.

| Test | Setup | Asserts |
|---|---|---|
| buys a label | a hot spare added | 3 units shipped. One call with 2 packages. One outbound Shipment with 2 packages. The Order has carrier `ups` and tracking number `1ZNEW02`. No lock row left |
| new label for Assets staged since | a first Ship, a third Asset staged, the aggregator then answers `1ZNEW03` | 1 unit shipped. Two Shipments, of 2 and 1 packages. The Order tracks `1ZNEW03` |
| typed by hand | the Order has carrier `dhl` and a typed number | 2 units shipped, nothing sent, the number kept |
| no label | the aggregator answers 400 | problem `No shipping label: HTTP 400: carrier account suspended`, `shipped: null`. `a1` staged, no Shipment, no work order |
| Asset moved on meanwhile | `a2` is put in the Spare pool as the label's Shipment is saved | 1 unit shipped. `a1` shipped. `a2` stays in the Spare pool with no Site. Nothing logged |
| Order saves refused | every update of the Order refused | two problems, in this order: `Tracking number 1ZNEW02 not saved on the Order: order is read only` and `On-site work opened but not linked to the Order: order is read only`. 2 units shipped, one Shipment, the Order's tracking number blank |

Confirming an install (7 tests). Extra fixture: the Order at stage installing, `a1` and `a2`
shipped at `site1`.

| Test | Setup | Asserts |
|---|---|---|
| staff confirm | `a2` has another Site | `{ confirmed: true, refused: 0 }`. Both pending in service, install completed 2026-11-10 09:00:00, Site `site1`. Nothing logged |
| Order held back | stage delivering, plus a staged Asset and a hot spare | confirmed. `a1` installed, the staged Asset and the hot spare unchanged |
| one unit refused | update of `a2` refused | `{ confirmed: true, refused: 1 }`. `a1` installed, `a2` shipped with no install time, one warning |
| nothing waiting | stage preparing, one staged Asset | `{ confirmed: false, why: 'nothing_waiting' }`, the Asset unchanged |
| the Customer | confirmer `customer` | `not_self_install` and nothing moved. With install mode self-install: confirmed and installed |
| form not saved | `saveForm` returns false | `{ confirmed: false, why: 'unsaved' }`, nothing moved |
| Order moves on | the test plays the after rule: the line becomes in service | the Order's stage is complete |

An install that replaces an Asset (2 tests). Extra fixture: a device-replace Order whose line of
quantity 1 replaces `old1`, an Asset in service at `site1`. `a1` is shipped.

| Test | Setup | Asserts |
|---|---|---|
| replacement installed | none | confirmed. One Return order `RET0001` for `acme` at `site1`, with one line for `old1` |
| replacement still shipped | update of `a1` refused | `{ confirmed: true, refused: 1 }`. No Return order, `old1` in service |

A work order closed complete (7 tests). Extra fixture: the Order at stage installing, `a1` shipped.
The work order is a record handed to `completeInstallOfWork`, initiated from the Order.

| Test | Setup | Asserts |
|---|---|---|
| install or swap (two cases) | purpose install, purpose swap | `a1` pending in service with its install time |
| not the Order's on-site work (five cases) | purpose de-install. Purpose site audit. No purpose. Initiated from nothing. Initiated from another record | `a1` stays shipped |

Structural patterns: `src/server/platform/returns.test.ts` and `src/server/platform/disposal.test.ts`.

## Done criteria

All local. No instance is needed. ALL must hold:

- [ ] `npx vitest run src/server/platform/delivery.test.ts` → 44 passed
- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm run check` exits 0
- [ ] `git show --stat --format= HEAD` lists the test file and no other file (`plans/README.md` aside)
- [ ] `git status --short` shows no file outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- **A new test fails.** First compare your file with the block in this plan and copy it again if it differs. If it still fails, stop. Report the test's full name, and the expected and received values that vitest prints. Do not change the code under test, do not edit the assertion, do not skip the test, and do not commit. The tests passed at `805d5da`, so a failure means the behaviour changed since, and the owner must decide which is right.
- A test throws an error that starts with `fake Glide:`. The fake does not model something the code now does. Changing `test-support/` is out of scope.
- A test fails with a network error, or anything suggests a real HTTP call was made. The stub of `@servicenow/glide/sn_ws` must take every call. Do not run the tests again until you know why it did not.
- The drift check shows a change in `delivery.ts` and the excerpts in "Current state" no longer match.
- `npm run typecheck` or `npm run lint` reports an error in the new file after you copied it again from this plan.
- `npm run check` changes `src/fluent/generated/keys.ts`. This plan adds no metadata, so that change comes from somewhere else.
- `src/server/platform/delivery.test.ts` already exists.

## Maintenance notes

- These are characterization tests. When Ship or the install changes on purpose, change the matching test in the same commit and say so in the commit body.
- Several tests assert a problem text word for word. A user reads those after pressing Ship. If the wording changes, update the test.
- Observed while planning, on the fake, and not pinned by a test: when the platform refuses the Order's save after a label purchase and accepts the later save that links the on-site work, that later save writes the carrier and tracking number too, because the same record still holds them. The user is then told `Tracking number ... not saved on the Order` although the Order has it. The owner may want to decide whether that message is right. It is not a reason to stop this plan.
- Not covered, and why:
  - Real concurrency. The fake runs one transaction at a time. The tests show that a held Ship lock stops a second Ship and that a second Ship opens no second work. That the lock row excludes a second request on an instance rests on the unique index (ADR 0013).
  - Line stages. The after rule on `alm_hardware` derives them on an instance, and the fake runs no rule. Two tests play the rule to show the Order follows its lines.
  - The visibility rules. Ship reads the Order's Assets past them (`beyondVisibility`), which changes nothing on the fake.
  - `installState` on its own, and the messages of `uiShipOrder` and `uiConfirmInstalled` in `src/server/entry/delivery.ts`.
  - A Return order the platform refuses when an install replaces an Asset. `src/server/platform/returns.test.ts` covers `raiseReturn`.
- Plan 030 tests `src/server/platform/shipping.ts`. The two test files stub the aggregator the same way and do not share code, on purpose: a test file here stands alone.
- At planning time each of these changes to `delivery.ts` made at least one of these tests fail: shipping without the Order's Ship lock, dropping the stage re-check after the label purchase, not placing an Asset at the Site, shipping after a failed label purchase, not linking the work order, not deriving the Order's stage after Ship, installing units that are not shipped, not stamping the install time, not returning a replaced Asset, returning it before its replacement is installed, ignoring an unsaved form, completing an install for any closed work order, and not handing hot spares over. A reviewer can repeat any of them.
- A reviewer should check that the commit holds the test file and nothing else.
