# Plan 030: Test tracking updates, label voids and label purchases on the fake Glide

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- src/server/platform/shipping.ts src/server/domain/shipping.ts src/server/platform/rest-messages.ts src/server/platform/locks.ts src/server/platform/events.ts src/server/domain/job-lock.ts src/server/domain/lock-names.ts src/server/domain/properties.ts src/server/test-support/fake-glide.ts src/server/test-support/encoded-query.ts src/server/platform/shipping.test.ts`
> The first ten paths are the code under test and the fake it runs on. The
> last one is the file you create, and must not exist yet. If any of the ten
> changed since this plan was written, compare the "Current state" excerpts
> against the live code before proceeding. On a mismatch, treat it as a STOP
> condition. A change to `fake-glide.ts` that only adds a method (another
> plan adds one) is not a mismatch.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

`src/server/platform/shipping.ts` is 555 lines. It buys carrier labels, which cost money, and it
applies the tracking webhook that tells a Customer where their equipment is. Its pure rules are
well tested in `src/server/domain/shipping.test.ts`. The service around them is not: the only unit
test that reaches it, `src/server/entry/shipping.test.ts:38-46`, sends a tracking number no
Shipment has and checks the webhook token. One ATF test
(`src/fluent/delivery/tests.now.ts:22`) sends one delivery twice, and it runs on an instance only.
Nothing local runs a tracking update against a stored Shipment, a late update that must not move a
Shipment back, a label marked voided under the Order's Ship lock, or the rule that a Return order
has one open label at a time. Each of those guards against a paid-for label bought twice or a
Shipment that shows a wrong status.

This plan adds 64 unit tests that pin what the code does today. It changes no behaviour. The tests
were written against commit `805d5da` and all pass there, so **a test that fails on the current
code is a finding to report, not a defect to fix in this plan**.

## Current state

Files and their roles:

- `src/server/platform/shipping.ts`. `trackShipment` and `retryTracking` apply a tracking update. `voidLabel` marks a label voided. `labelReturn` and `labelOrder` buy a label. `orderLabelBought` tells a bought label from a typed number. Not changed.
- `src/server/domain/shipping.ts`. The pure rules (`applyTracking`, `statusOvertaken`, `newTrackingEvents`, `buyLabel`, `voidedLabelOrderNote`, `returnLabelRefusal`). Already unit-tested.
- `src/server/platform/rest-messages.ts`. `restMessagePort` makes the outbound HTTP call through `RESTMessageV2`. Not changed.
- `src/server/test-support/fake-glide.ts`. The in-memory Glide the tests run on. Not changed.
- `src/server/platform/shipping.test.ts`. Does not exist. You create it.

A tracking update is applied under the Shipment's tracking lock. One held off is queued:

```ts
// src/server/platform/shipping.ts:374-379
export function trackShipment(update: TrackingUpdate): WebhookTracking {
    const found = new GlideRecord(SHIPMENT)
    if (!found.get('tracking_number', update.trackingNumber)) return { outcome: 'unmatched' }
    const tracking = settle(trackUnderLock(found.getUniqueValue(), update, newestEventAt(update.events)), update)
    return tracking.outcome === 'busy' && trackLater(found, update) ? { outcome: 'queued' } : tracking
}
```

An update that is older news adds its events only. Events already stored are skipped:

```ts
// src/server/platform/shipping.ts:497-520
function track(shipment: GlideRecord, update: TrackingUpdate, newestAt: string): Saved | { error: true } {
    const shipmentId = shipment.getUniqueValue()
    const stored = storedEvents(shipmentId)
    let status = str(shipment, 'status') as ShipmentStatus
    let deliveredNow = false
    if (!statusOvertaken(update, newestAt, stored.times)) {
        const applied = applyTracking(status, update)
        status = applied.status
        deliveredNow = applied.deliveredNow
        shipment.setValue('status', status)
        if (applied.detail !== undefined) shipment.setValue('status_detail', applied.detail)
        if (update.estimatedDelivery) shipment.setValue('estimated_delivery', update.estimatedDelivery)
        if (deliveredNow) {
            const deliveredMs = Date.parse(update.deliveredAt ?? '')
            shipment.setValue('delivered_at', msToGlide(Number.isFinite(deliveredMs) ? deliveredMs : nowMs()))
        }
        if (!shipment.update()) {
            warnRefused(shipment, `Tracking update of ${update.trackingNumber} not saved`)
            return { error: true }
        }
    }
    const unrecorded = recordEvents(shipmentId, update.trackingNumber, newTrackingEvents(stored.keys, update.events))
    return { status, deliveredNow, orderId: str(shipment, 'order'), carrier: str(shipment, 'carrier'), unrecorded }
}
```

A delivery is noted on the Order once:

```ts
// src/server/platform/shipping.ts:453-460
function noteDelivery(saved: Saved, trackingNumber: string): void {
    if (!saved.deliveredNow) return
    const order = findById('x_daas_ham_order', saved.orderId)
    if (!order) return
    order.setValue('work_notes', `Delivered to ${order.getDisplayValue('site')} (${saved.carrier} ${trackingNumber}).`)
    // The delivery is on the Shipment; only the Order's note is lost.
    if (!order.update()) warnRefused(order, `${str(order, 'number')} not noted as delivered (${saved.carrier} ${trackingNumber})`)
}
```

An outbound label is voided, and its Order cleared of it, under the Order's Ship lock:

```ts
// src/server/platform/shipping.ts:277-287
function voidOutboundLabel(shipmentId: string, trackingNumber: string, orderId: string): VoidOutcome {
    const voiding = withLock(LOCK.shipOrder(orderId), (): VoidOutcome => {
        const saved = saveVoided(shipmentId, trackingNumber)
        if ('why' in saved) return notVoided(saved.why)
        const voided = saved.shipment
        return clearOrderTracking(orderId, { trackingNumber: str(voided, 'tracking_number'), carrier: str(voided, 'carrier') })
    })
    if (voiding.ran) return voiding.value
    const busy = 'a Ship of its Order, or a void of one of its labels, is running. Try again once it has finished'
    return notVoided(`Label ${trackingNumber} not marked voided: ${busy}`)
}
```

A Return order has one open label, checked and bought under a lock on the Return order:

```ts
// src/server/platform/shipping.ts:184-196
export function labelReturn(returnOrder: GlideRecord): ReturnLabelOutcome {
    const returnOrderId = returnOrder.getUniqueValue()
    const packages = count('x_daas_ham_return_order_line', `return_order=${returnOrderId}^status=${AWAITED}`)
    if (packages === 0) return { bought: false, why: 'Nothing on this return is still awaited' }
    const label = withLock(LOCK.returnLabel(returnOrderId), (lock): LabelResult => {
        const open = returnLabels([returnOrderId]).get(returnOrderId)
        if (open) return { ok: false, error: returnLabelRefusal(open.trackingNumber, open.status) }
        const bought = createShipment(SHIPMENT_DIRECTION.return, returnOrder, packages, lock)
        return bought.ok ? bought : { ok: false, error: `No label: ${bought.error}` }
    })
    if (!label.ran) return { bought: false, why: 'A return label is already being bought for this return: reload it to see it' }
    const result = label.value
    if (!result.ok) return { bought: false, why: result.error }
```

The seam for the outbound call. `createShipment` (`shipping.ts:85-138`) buys through
`restMessagePort(SHIPPING_MESSAGE.name)`, which constructs a `RESTMessageV2`:

```ts
// src/server/platform/rest-messages.ts:10-11
/** The typings expose RESTMessageV2's Rhino constructor; at runtime it takes (message, function). */
const RestMessage = RESTMessageV2 as unknown as new (message: string, fn: string) => RESTMessageV2
```

A test replaces that class with `vi.mock('@servicenow/glide/sn_ws', ...)`. The repo already does
so in `src/server/platform/oem-sync.test.ts:16-30`. The test file of this plan uses the same
pattern, with a class that records the request body, answers what the test set, and runs a hook
(`aggregator.whileCalled`) at the moment of the call. So the label purchase is tested too, and no
call leaves the machine.

How job locks behave (ADR 0013). A lock is a row in `x_daas_ham_job_lock` behind a unique index on
`name`. `withLock(name, work)` runs `work` holding it, or returns `{ ran: false }` at once when
another holder has it. `withLockTries` tries five times back to back. A test holds a lock by
storing its row, with `platform.uniqueKeys = { x_daas_ham_job_lock: 'name' }` set. The lock names
are `LOCK.trackShipment(shipmentId)`, `LOCK.shipOrder(orderId)` and
`LOCK.returnLabel(returnOrderId)` in `src/server/domain/lock-names.ts`.

Conventions that apply (from `AGENTS.md` and `README.md` "Development"):

- A test is a `*.test.ts` file beside the module it tests. The build leaves it out of the app.
- A relative import in `src/server` names the `.ts` file (`'./shipping.ts'`, not `'./shipping'`).
- A test of `platform/` runs against `test-support/fake-glide.ts`. Each test file mocks Glide with this exact line, after its imports:
  `vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)`
- Use the words of `CONTEXT.md` in test names: Order, Return order, Shipment, Site, Customer.
- Model the structure on `src/server/platform/returns.test.ts` and `src/server/platform/oem-sync.test.ts`.

What the tests rely on in the fake (`src/server/test-support/fake-glide.ts`):

- `platform.reset()` clears everything. `platform.tables[table]` holds the stored rows, and a test seeds and reads them directly.
- A field that was never set to a non-blank value is absent from the stored row. That is why some assertions read `row.field ?? ''`.
- `update()` saves only the fields that changed, and does nothing when none did. A work note is a plain field on the fake. On an instance it is a journal field that reads blank once saved, so the test of "noted once" blanks it by hand between the two updates.
- `platform.refuses(table, row, operation)` returns why a save is refused. `platform.onSave` is not used here.
- `platform.events` lists the events queued with `gs.eventQueue` (`delayed: false`) and `gs.eventQueueScheduled` (`delayed: true`).
- `platform.logs` holds each log line as `<level> <message>`. `platform.warnings` holds the warnings without the level.
- A choice field's display value is its stored value on the fake (`in_transit`, not `In transit`). So the test of a label that cannot be voided matches the message with a pattern, not word for word.
- The fake runs no business rule, ACL or flow.

No secret is needed. The aggregator's API key is a password2 property that the tests leave unset,
and the stub ignores it. Do not put a real key, token or carrier account in the test file.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| The test file | `npx vitest run src/server/platform/shipping.test.ts` | all pass |
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

- `src/server/platform/shipping.test.ts` (create)
- `plans/README.md` (your status row only)

**Out of scope** (do NOT touch):

- `src/server/platform/shipping.ts`, `src/server/domain/shipping.ts` and every other non-test file. This plan changes no behaviour, even where a test shows behaviour you think is wrong.
- `src/server/test-support/fake-glide.ts`. The tests need nothing the fake lacks. If one throws `fake Glide:`, stop.
- `src/server/entry/shipping.test.ts`. Its two tests stay as they are.
- `shipOrder` in `src/server/platform/delivery.ts`, which calls `labelOrder`. Plan 031 tests it.
- ATF tests of shipping.

## Git workflow

- Branch: `advisor/030-shipping-characterization`
- One commit. Subject in the repo's style (an imperative sentence under 72 characters), for example:
  `Test tracking updates, label voids and label purchases`
  The body says that no unit test ran `platform/shipping.ts` against a stored Shipment, and that the tests pin the behaviour as it is at `805d5da`.
- Do NOT push or open a PR unless the operator told you to.

## Steps

### Step 1: Record the baseline

**Verify**: `npx vitest run src/server/platform src/server/entry/shipping.test.ts` → all pass. `ls src/server/platform/shipping.test.ts` → "No such file".

### Step 2: Create the tests

Create `src/server/platform/shipping.test.ts` with exactly this content:

```ts
import { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EVENT } from '../domain/events.ts'
import { LOCK } from '../domain/lock-names.ts'
import { PROPERTY } from '../domain/properties.ts'
import { SHIPPING_MESSAGE, type TrackingEvent, type TrackingUpdate } from '../domain/shipping.ts'
import { withLock } from './locks.ts'
import { labelOrder, labelReturn, orderLabelBought, retryTracking, trackShipment, voidLabel } from './shipping.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

/** What the aggregator is sent, what it answers each call, and what happens on the platform while it is called. */
const aggregator = {
    sent: [] as Array<{ message: string; fn: string; body: string }>,
    answer: { status: 200, body: '' },
    whileCalled: (): void => undefined,
}

vi.mock('@servicenow/glide/sn_ws', () => ({
    RESTMessageV2: class {
        private body = ''
        constructor(
            private readonly message: string,
            private readonly fn: string,
        ) {}
        setStringParameterNoEscape(): void {}
        setRequestHeader(): void {}
        setRequestBody(body: string): void {
            this.body = body
        }
        execute() {
            aggregator.sent.push({ message: this.message, fn: this.fn, body: this.body })
            aggregator.whileCalled()
            return { getStatusCode: () => aggregator.answer.status, getBody: () => aggregator.answer.body, getErrorMessage: () => '' }
        }
    },
}))

const SHIPMENTS = 'x_daas_ham_shipment'
const SHIPMENT_EVENTS = 'x_daas_ham_shipment_event'
const ORDERS = 'x_daas_ham_order'
const RETURNS = 'x_daas_ham_return_order'
const RETURN_LINES = 'x_daas_ham_return_order_line'
const LOCKS = 'x_daas_ham_job_lock'

const rows = (table: string): Row[] => platform.tables[table] ?? []
const shipment = (id = 'shp1'): Row => rows(SHIPMENTS).find((row) => row.sys_id === id) ?? {}
const order = (): Row => rows(ORDERS)[0] ?? {}
const returnOrder = (): Row => rows(RETURNS)[0] ?? {}
const storedEvents = () => rows(SHIPMENT_EVENTS).map((row) => [row.shipment, row.occurred_at, row.status, row.description, row.location])

function record(table: string, id: string): GlideRecord {
    const found = new GlideRecord(table)
    found.get(id)
    return found
}

/** Another holder has the lock `name`: its row is stored, taken just now. */
function held(name: string): void {
    rows(LOCKS).push({ sys_id: `lock-${name}`, name, sys_created_on: '2026-11-10 09:00:00' })
}

const PICKED_UP: TrackingEvent = { occurredAt: '2026-11-10T08:00:00Z', status: 'in_transit', description: 'Picked up', location: 'Oslo, NO' }
const AT_HUB: TrackingEvent = { occurredAt: '2026-11-10T14:00:00Z', status: 'in_transit', description: 'Arrived at hub', location: 'Bergen, NO' }
const ON_VAN: TrackingEvent = { occurredAt: '2026-11-11T07:00:00Z', status: 'out_for_delivery', description: 'Out for delivery', location: 'Bergen, NO' }
const HANDED_OVER: TrackingEvent = { occurredAt: '2026-11-11T10:15:00Z', status: 'delivered', description: 'Delivered', location: 'Bergen, NO' }

function update(fields: Partial<TrackingUpdate> = {}): TrackingUpdate {
    return { trackingNumber: '1Z999', status: 'in_transit', description: 'Arrived at hub', estimatedDelivery: '2026-11-12', events: [PICKED_UP, AT_HUB], ...fields }
}

const OUT_FOR_DELIVERY = update({ status: 'out_for_delivery', description: 'Out for delivery', estimatedDelivery: '2026-11-11', events: [PICKED_UP, AT_HUB, ON_VAN] })
const DELIVERED = update({ status: 'delivered', description: 'Delivered', deliveredAt: '2026-11-11T10:15:00Z', events: [PICKED_UP, AT_HUB, ON_VAN, HANDED_OVER] })

beforeEach(() => {
    platform.reset()
    aggregator.sent.length = 0
    aggregator.answer = { status: 200, body: '' }
    aggregator.whileCalled = () => undefined
    platform.clock = Date.parse('2026-11-10T09:00:00Z')
    platform.user = { ...platform.user, id: 'u1', name: 'Ada' }
    platform.uniqueKeys = { [LOCKS]: 'name' }
    platform.references = {
        [`${ORDERS}.site`]: 'cmn_location',
        [`${ORDERS}.customer`]: 'core_company',
        [`${RETURNS}.customer`]: 'core_company',
    }
    platform.tables[LOCKS] = []
    platform.tables.core_company = [{ sys_id: 'acme', name: 'Acme' }]
    platform.tables.cmn_location = [
        { sys_id: 'site1', name: 'Acme HQ', street: 'Storgata 1', city: 'Bergen', zip: '5003', country: 'NO', phone: '+47 55 00 00 00' },
        { sys_id: 'depot-location', name: 'Depot', street: 'Havnegata 2', city: 'Oslo', zip: '0150', country: 'Norway' },
    ]
    platform.tables.alm_stockroom = [{ sys_id: 'depot', name: 'Central depot', location: 'depot-location' }]
    platform.tables[ORDERS] = [{ sys_id: 'o1', number: 'ORD0001', customer: 'acme', site: 'site1', carrier: 'ups', tracking_number: '1Z999' }]
    platform.tables[SHIPMENTS] = [
        { sys_id: 'shp1', number: 'NSHP0001', direction: 'to_site', order: 'o1', customer: 'acme', site: 'site1', carrier: 'ups', tracking_number: '1Z999', status: 'label_created' },
    ]
    platform.tables[SHIPMENT_EVENTS] = []
})

describe('a tracking update for a stored Shipment', () => {
    it('sets its status, latest update and estimated delivery, and stores its events', () => {
        expect(trackShipment(update())).toEqual({ outcome: 'applied', status: 'in_transit' })

        expect(shipment()).toMatchObject({ status: 'in_transit', status_detail: 'Arrived at hub', estimated_delivery: '2026-11-12' })
        expect(shipment().delivered_at ?? '').toBe('')
        expect(storedEvents()).toEqual([
            ['shp1', '2026-11-10T08:00:00Z', 'in_transit', 'Picked up', 'Oslo, NO'],
            ['shp1', '2026-11-10T14:00:00Z', 'in_transit', 'Arrived at hub', 'Bergen, NO'],
        ])
        expect(order().work_notes ?? '').toBe('')
        expect(rows(LOCKS)).toEqual([])
        expect(platform.logs).toEqual([])
    })

    it('is unmatched, and writes nothing, when no Shipment has its tracking number', () => {
        expect(trackShipment(update({ trackingNumber: 'NOSUCH1' }))).toEqual({ outcome: 'unmatched' })

        expect(shipment().status).toBe('label_created')
        expect(storedEvents()).toEqual([])
    })

    it('stores no event twice when the same update is sent again', () => {
        trackShipment(update())

        expect(trackShipment(update())).toEqual({ outcome: 'applied', status: 'in_transit' })

        expect(storedEvents()).toHaveLength(2)
    })

    it('adds only the events not stored yet when the whole history is sent again', () => {
        trackShipment(update())

        expect(trackShipment(OUT_FOR_DELIVERY)).toEqual({ outcome: 'applied', status: 'out_for_delivery' })

        expect(shipment()).toMatchObject({ status: 'out_for_delivery', status_detail: 'Out for delivery', estimated_delivery: '2026-11-11' })
        expect(storedEvents().map(([, , , description]) => description)).toEqual(['Picked up', 'Arrived at hub', 'Out for delivery'])
    })

    it('stores an event once when one update lists it twice', () => {
        trackShipment(update({ events: [PICKED_UP, PICKED_UP] }))

        expect(storedEvents()).toHaveLength(1)
    })

    it('that is older than one already applied adds its events and leaves the status, latest update and estimate alone', () => {
        trackShipment(update({ status: 'out_for_delivery', description: 'Out for delivery', estimatedDelivery: '2026-11-11', events: [ON_VAN] }))

        expect(trackShipment(update())).toEqual({ outcome: 'applied', status: 'out_for_delivery' })

        expect(shipment()).toMatchObject({ status: 'out_for_delivery', status_detail: 'Out for delivery', estimated_delivery: '2026-11-11' })
        expect(storedEvents().map(([, , , description]) => description)).toEqual(['Out for delivery', 'Picked up', 'Arrived at hub'])
    })

    it('of unknown status keeps the status and the latest update, and stores its events', () => {
        trackShipment(update())

        expect(trackShipment(update({ status: 'unknown', description: 'No information', events: [PICKED_UP, AT_HUB, ON_VAN] }))).toEqual({ outcome: 'applied', status: 'in_transit' })

        expect(shipment()).toMatchObject({ status: 'in_transit', status_detail: 'Arrived at hub' })
        expect(storedEvents()).toHaveLength(3)
    })

    it('does not put a voided label back in use', () => {
        Object.assign(shipment(), { status: 'voided', status_detail: 'Voided with the carrier (marked by Ada)' })

        expect(trackShipment(update({ status: 'exception', description: 'Label cancelled' }))).toEqual({ outcome: 'applied', status: 'voided' })

        expect(shipment()).toMatchObject({ status: 'voided', status_detail: 'Voided with the carrier (marked by Ada)' })
    })
})

describe('a delivery', () => {
    it("is saved with the carrier's delivery time and noted on the Shipment's Order", () => {
        expect(trackShipment(DELIVERED)).toEqual({ outcome: 'applied', status: 'delivered' })

        expect(shipment()).toMatchObject({ status: 'delivered', status_detail: 'Delivered', delivered_at: '2026-11-11 10:15:00' })
        expect(order().work_notes).toBe('Delivered to Acme HQ (ups 1Z999).')
        expect(storedEvents()).toHaveLength(4)
    })

    it('is noted once, however often the update is sent', () => {
        trackShipment(DELIVERED)
        // A journal field reads blank once its entry is saved.
        order().work_notes = ''

        expect(trackShipment(DELIVERED)).toEqual({ outcome: 'applied', status: 'delivered' })

        expect(order().work_notes).toBe('')
        expect(shipment().delivered_at).toBe('2026-11-11 10:15:00')
        expect(storedEvents()).toHaveLength(4)
    })

    it('takes the time now when the carrier gives no delivery time', () => {
        trackShipment(update({ status: 'delivered', description: 'Delivered', deliveredAt: undefined, events: [] }))

        expect(shipment().delivered_at).toBe('2026-11-10 09:00:00')
    })

    it('stays delivered when an older update arrives after it', () => {
        trackShipment(DELIVERED)

        expect(trackShipment(update())).toEqual({ outcome: 'applied', status: 'delivered' })

        expect(shipment()).toMatchObject({ status: 'delivered', status_detail: 'Delivered' })
    })

    it('is taken after a newer event is stored: a delivery is never older news', () => {
        const later: TrackingEvent = { occurredAt: '2026-11-12T08:00:00Z', status: 'unknown', description: 'Proof of delivery filed', location: '' }
        trackShipment(update({ status: 'unknown', description: '', events: [later] }))

        expect(trackShipment(DELIVERED)).toEqual({ outcome: 'applied', status: 'delivered' })

        expect(shipment().status).toBe('delivered')
    })

    it('becomes returned when the carrier sends it back', () => {
        trackShipment(DELIVERED)
        const sentBack: TrackingEvent = { occurredAt: '2026-11-13T08:00:00Z', status: 'returned', description: 'Returned to sender', location: '' }

        expect(trackShipment(update({ status: 'returned', description: 'Returned to sender', events: [sentBack] }))).toEqual({ outcome: 'applied', status: 'returned' })

        expect(shipment()).toMatchObject({ status: 'returned', status_detail: 'Returned to sender' })
    })

    it('stays on the Shipment, with a warning, when the platform refuses the note on the Order', () => {
        platform.refuses = (table) => (table === ORDERS ? 'order is read only' : '')

        expect(trackShipment(DELIVERED)).toEqual({ outcome: 'applied', status: 'delivered' })

        expect(shipment().status).toBe('delivered')
        expect(order().work_notes ?? '').toBe('')
        expect(platform.warnings).toEqual([expect.stringContaining('ORD0001 not noted as delivered (ups 1Z999): order is read only')])
    })

    it('of a return label notes no Order', () => {
        platform.tables[SHIPMENTS] = [{ sys_id: 'shp1', direction: 'return', return_order: 'ret1', carrier: 'ups', tracking_number: '1Z999', status: 'in_transit' }]

        expect(trackShipment(DELIVERED)).toEqual({ outcome: 'applied', status: 'delivered' })

        expect(order().work_notes ?? '').toBe('')
    })
})

describe('a tracking update the platform refuses', () => {
    it('is reported, with a warning and no event stored, when the Shipment is not saved', () => {
        platform.refuses = (table) => (table === SHIPMENTS ? 'shipment is read only' : '')

        expect(trackShipment(update())).toEqual({ outcome: 'shipment_refused' })

        expect(shipment().status).toBe('label_created')
        expect(storedEvents()).toEqual([])
        expect(platform.warnings).toEqual([expect.stringContaining('Tracking update of 1Z999 not saved: shipment is read only')])
        expect(rows(LOCKS)).toEqual([])
    })

    it('counts the events not stored, the status saved, and stores them when the update is sent again', () => {
        platform.refuses = (table, row) => (table === SHIPMENT_EVENTS && row.description === 'Arrived at hub' ? 'no room' : '')

        expect(trackShipment(update())).toEqual({ outcome: 'events_refused', count: 1 })

        expect(shipment().status).toBe('in_transit')
        expect(storedEvents().map(([, , , description]) => description)).toEqual(['Picked up'])
        expect(platform.warnings).toEqual([expect.stringContaining('Tracking event of 1Z999 at 2026-11-10T14:00:00Z not recorded: no room')])

        platform.refuses = () => ''
        expect(trackShipment(update())).toEqual({ outcome: 'applied', status: 'in_transit' })

        expect(storedEvents().map(([, , , description]) => description)).toEqual(['Picked up', 'Arrived at hub'])
    })
})

describe("a tracking update held off by the Shipment's tracking lock", () => {
    const queued = () => platform.events.filter((event) => event.name === EVENT.trackShipment)

    it('is queued to be applied in the background, and changes nothing yet', () => {
        held(LOCK.trackShipment('shp1'))

        expect(trackShipment(update())).toEqual({ outcome: 'queued' })

        expect(shipment().status).toBe('label_created')
        expect(storedEvents()).toEqual([])
        expect(queued()).toEqual([expect.objectContaining({ record: 'shp1', parm2: '0', delayed: false })])
        expect(platform.logs).toEqual([expect.stringMatching(/^info .*Tracking update of Shipment NSHP0001 \(1Z999\) queued in 1 event\(s\): another update held its lock/)])
    })

    it('is applied by its queued retry once the lock is free', () => {
        held(LOCK.trackShipment('shp1'))
        trackShipment(update())
        platform.tables[LOCKS] = []
        const [event] = queued()

        retryTracking(record(SHIPMENTS, 'shp1'), event?.parm1 ?? '', 0)

        expect(shipment()).toMatchObject({ status: 'in_transit', status_detail: 'Arrived at hub', estimated_delivery: '2026-11-12' })
        expect(storedEvents()).toHaveLength(2)
        expect(platform.events).toHaveLength(1)
    })

    it('is busy, with a warning, when an event is too long to queue', () => {
        held(LOCK.trackShipment('shp1'))
        const endless: TrackingEvent = { ...PICKED_UP, occurredAt: 'x'.repeat(4001) }

        expect(trackShipment(update({ events: [endless] }))).toEqual({ outcome: 'busy' })

        expect(platform.events).toEqual([])
        expect(platform.warnings).toEqual([expect.stringContaining('Tracking update of Shipment NSHP0001 (1Z999) not queued: an event is too long to queue')])
    })
})

describe('a queued tracking retry', () => {
    const PARAM = JSON.stringify({ trackingNumber: '1Z999', status: 'in_transit', description: 'Arrived at hub', newestAt: AT_HUB.occurredAt, events: [PICKED_UP, AT_HUB] })
    const retry = (param: string, tries: number) => retryTracking(record(SHIPMENTS, 'shp1'), param, tries)

    it('still held off is queued again a minute later, counted', () => {
        held(LOCK.trackShipment('shp1'))

        retry(PARAM, 3)

        expect(platform.events).toEqual([{ name: EVENT.trackShipment, record: 'shp1', parm1: PARAM, parm2: '4', delayed: true }])
        expect(platform.logs).toEqual([expect.stringMatching(/^info .*tried again in 60 s: another update held its lock/)])
        expect(shipment().status).toBe('label_created')
    })

    it('is dropped with a warning once it was queued again 15 times', () => {
        held(LOCK.trackShipment('shp1'))

        retry(PARAM, 15)

        expect(platform.events).toEqual([])
        expect(platform.warnings).toEqual([
            expect.stringContaining('Tracking update of Shipment NSHP0001 (1Z999) dropped after 15 tries (another update held its lock): check the Shipment with the carrier'),
        ])
    })

    it('is queued again when the platform refuses the Shipment', () => {
        platform.refuses = (table) => (table === SHIPMENTS ? 'shipment is read only' : '')

        retry(PARAM, 0)

        expect(platform.events).toEqual([expect.objectContaining({ parm1: PARAM, parm2: '1', delayed: true })])
        expect(platform.logs).toContainEqual(expect.stringMatching(/^info .*tried again in 60 s: the platform refused the Shipment/))
    })

    it('whose status is older than an event stored since adds its events only', () => {
        trackShipment(update({ status: 'out_for_delivery', description: 'Out for delivery', estimatedDelivery: '2026-11-11', events: [ON_VAN] }))

        retry(PARAM, 0)

        expect(shipment()).toMatchObject({ status: 'out_for_delivery', status_detail: 'Out for delivery' })
        expect(storedEvents()).toHaveLength(3)
        expect(platform.events).toEqual([])
    })

    it('that is not an update is dropped with a warning', () => {
        retry('not json', 0)

        expect(platform.events).toEqual([])
        expect(platform.warnings).toEqual([expect.stringContaining('Tracking retry of Shipment NSHP0001 (1Z999) dropped: parm1 is not an update')])
    })
})

describe('marking an outbound label voided', () => {
    const NOTE =
        'Shipping label ups 1Z999 was voided with the carrier, so its tracking number and carrier were cleared from this Order; its units stay shipped. ' +
        'Buy the replacement label with the carrier, then type its carrier and tracking number on the Order.'

    it("voids the Shipment and clears the Order's tracking number and carrier, with a work note", () => {
        expect(voidLabel('shp1', '1Z999')).toEqual({
            voided: true,
            message: 'Label 1Z999 marked voided and cleared from ORD0001: buy the replacement with the carrier and type its tracking number on the Order',
            leftUndone: false,
        })

        expect(shipment()).toMatchObject({ status: 'voided', status_detail: 'Voided with the carrier (marked by Ada)' })
        expect(order()).toMatchObject({ tracking_number: '', carrier: '', work_notes: NOTE })
        expect(rows(LOCKS)).toEqual([])
        expect(platform.logs).toEqual([])
    })

    it('voids a label stuck in an exception too', () => {
        shipment().status = 'exception'

        expect(voidLabel('shp1', '1Z999')).toMatchObject({ voided: true, leftUndone: false })

        expect(shipment().status).toBe('voided')
    })

    it('leaves an Order that tracks another label as it is', () => {
        Object.assign(order(), { tracking_number: '1Z777' })

        expect(voidLabel('shp1', '1Z999')).toEqual({ voided: true, message: 'Label 1Z999 marked voided', leftUndone: false })

        expect(shipment().status).toBe('voided')
        expect(order()).toMatchObject({ tracking_number: '1Z777', carrier: 'ups' })
        expect(order().work_notes ?? '').toBe('')
    })

    it("changes nothing while a Ship of its Order holds the Order's Ship lock", () => {
        held(LOCK.shipOrder('o1'))

        expect(voidLabel('shp1', '1Z999')).toEqual({
            voided: false,
            why: 'Label 1Z999 not marked voided: a Ship of its Order, or a void of one of its labels, is running. Try again once it has finished',
        })

        expect(shipment().status).toBe('label_created')
        expect(order()).toMatchObject({ tracking_number: '1Z999', carrier: 'ups' })
    })

    it('changes nothing while a tracking update holds its tracking lock through every try', () => {
        held(LOCK.trackShipment('shp1'))

        expect(voidLabel('shp1', '1Z999')).toEqual({ voided: false, why: 'Label 1Z999 not marked voided: a tracking update of it is being saved. Try again' })

        expect(shipment().status).toBe('label_created')
        expect(order().tracking_number).toBe('1Z999')
        expect(rows(LOCKS).map((lock) => lock.name)).toEqual([LOCK.trackShipment('shp1')])
    })

    it.each(['in_transit', 'out_for_delivery', 'delivered', 'returned', 'unknown', 'voided'])('refuses a label that is %s', (status) => {
        shipment().status = status

        expect(voidLabel('shp1', '1Z999')).toEqual({ voided: false, why: expect.stringMatching(/^Label 1Z999 is .*, so it cannot be marked voided$/) })

        expect(shipment().status).toBe(status)
        expect(order().tracking_number).toBe('1Z999')
    })

    it('says so when the Shipment is gone', () => {
        expect(voidLabel('no-such-shipment', '1Z999')).toEqual({ voided: false, why: 'Label 1Z999 no longer exists' })
    })

    it("leaves the label open, and the Order as it is, when the platform refuses the Shipment's save", () => {
        platform.refuses = (table) => (table === SHIPMENTS ? 'shipment is read only' : '')

        expect(voidLabel('shp1', '1Z999')).toEqual({ voided: false, why: 'Label 1Z999 not marked voided: shipment is read only' })

        expect(shipment().status).toBe('label_created')
        expect(order().tracking_number).toBe('1Z999')
    })

    it('says what to clear by hand when the platform refuses to save the Order', () => {
        platform.refuses = (table) => (table === ORDERS ? 'order is read only' : '')

        expect(voidLabel('shp1', '1Z999')).toEqual({
            voided: true,
            message: 'Label 1Z999 marked voided, but ORD0001 still names it (order is read only): clear its tracking number and carrier by hand',
            leftUndone: true,
        })

        expect(shipment().status).toBe('voided')
        expect(order()).toMatchObject({ tracking_number: '1Z999', carrier: 'ups' })
    })
})

describe('a Return order and its prepaid label', () => {
    const LABEL = JSON.stringify({
        label_id: 'se-123',
        tracking_number: '1ZRET01',
        carrier_code: 'ups',
        label_download: { pdf: 'https://labels.example/se-123.pdf' },
        shipment_cost: { amount: 12.5, currency: 'nok' },
    })
    const returnLabel = (fields: Row = {}): Row => ({ sys_id: 'shp2', direction: 'return', return_order: 'ret1', carrier: 'ups', tracking_number: '1ZOLD', status: 'label_created', ...fields })
    const requestLabel = () => labelReturn(record(RETURNS, 'ret1'))

    beforeEach(() => {
        aggregator.answer = { status: 200, body: LABEL }
        platform.properties = { [PROPERTY.shippingCarrierId.name]: 'se-carrier', [PROPERTY.stagingStockroom.name]: 'depot', [PROPERTY.shippingSenderPhone.name]: '+47 22 00 00 00' }
        platform.tables[RETURNS] = [{ sys_id: 'ret1', number: 'RET0001', customer: 'acme', site: 'site1' }]
        platform.tables[RETURN_LINES] = [
            { sys_id: 'line1', return_order: 'ret1', asset: 'a1', status: 'awaiting' },
            { sys_id: 'line2', return_order: 'ret1', asset: 'a2', status: 'awaiting' },
            { sys_id: 'line3', return_order: 'ret1', asset: 'a3', status: 'received' },
        ]
    })

    it('gets one label from the Site to the depot, a box per unit still awaited, recorded as a Shipment and noted on it', () => {
        expect(requestLabel()).toEqual({ bought: true, trackingNumber: '1ZRET01' })

        expect(aggregator.sent).toHaveLength(1)
        expect(aggregator.sent[0]).toMatchObject({ message: SHIPPING_MESSAGE.name, fn: SHIPPING_MESSAGE.fn.createLabel })
        const sent = JSON.parse(aggregator.sent[0]?.body ?? '{}') as { shipment: { carrier_id: string; ship_from: Row; ship_to: Row; packages: unknown[] } }
        expect(sent.shipment.carrier_id).toBe('se-carrier')
        expect(sent.shipment.ship_from).toMatchObject({ name: 'Acme HQ', company_name: 'Acme', city_locality: 'Bergen', country_code: 'NO' })
        expect(sent.shipment.ship_to).toMatchObject({ name: 'Central depot', city_locality: 'Oslo', country_code: 'NO' })
        expect(sent.shipment.packages).toHaveLength(2)
        expect(rows(SHIPMENTS).find((row) => row.return_order === 'ret1')).toMatchObject({
            direction: 'return',
            customer: 'acme',
            site: 'site1',
            stockroom: 'depot',
            carrier: 'ups',
            service_code: 'ups_standard',
            packages: '2',
            tracking_number: '1ZRET01',
            label_id: 'se-123',
            label_url: 'https://labels.example/se-123.pdf',
            cost: '12.5',
            currency: 'NOK',
            status: 'label_created',
        })
        expect(returnOrder().work_notes).toBe('Return label 1ZRET01 (ups): https://labels.example/se-123.pdf')
        expect(rows(LOCKS)).toEqual([])
        expect(platform.logs).toEqual([])
    })

    it('gets none when nothing on it is still awaited', () => {
        platform.tables[RETURN_LINES] = [{ sys_id: 'line3', return_order: 'ret1', asset: 'a3', status: 'received' }]

        expect(requestLabel()).toEqual({ bought: false, why: 'Nothing on this return is still awaited' })

        expect(aggregator.sent).toEqual([])
    })

    it.each([
        ['label_created', 'Return label 1ZOLD is still open; void it with the carrier, then use Mark label voided on its Shipment, before buying another'],
        ['exception', 'Return label 1ZOLD is still open; void it with the carrier, then use Mark label voided on its Shipment, before buying another'],
        ['in_transit', 'Return label 1ZOLD is already under way with the carrier; no other label is needed'],
        ['out_for_delivery', 'Return label 1ZOLD is already under way with the carrier; no other label is needed'],
        ['unknown', 'Return label 1ZOLD is still open and its status is unknown; check it with the carrier before buying another'],
    ])('gets no second label while one is open (%s), and nothing is bought', (status, why) => {
        rows(SHIPMENTS).push(returnLabel({ status }))

        expect(requestLabel()).toEqual({ bought: false, why })

        expect(aggregator.sent).toEqual([])
        expect(rows(SHIPMENTS)).toHaveLength(2)
    })

    it.each(['voided', 'delivered', 'returned'])('gets a new label once its last one is %s', (status) => {
        rows(SHIPMENTS).push(returnLabel({ status }))

        expect(requestLabel()).toEqual({ bought: true, trackingNumber: '1ZRET01' })

        expect(aggregator.sent).toHaveLength(1)
    })

    it('gets none while another request holds its label lock, and nothing is bought', () => {
        held(LOCK.returnLabel('ret1'))

        expect(requestLabel()).toEqual({ bought: false, why: 'A return label is already being bought for this return: reload it to see it' })

        expect(aggregator.sent).toEqual([])
        expect(rows(SHIPMENTS)).toHaveLength(1)
    })

    it('gets none, and nothing is sent, while no carrier account is set', () => {
        delete platform.properties[PROPERTY.shippingCarrierId.name]

        expect(requestLabel()).toEqual({ bought: false, why: 'No label: set x_daas_ham.shipping.carrier_id to the ShipEngine carrier account (se-...) billed for labels' })

        expect(aggregator.sent).toEqual([])
    })

    it('gets none, and nothing is sent, while the Site has no address a carrier takes', () => {
        Object.assign(rows('cmn_location')[0] ?? {}, { street: '', zip: '' })

        expect(requestLabel()).toEqual({ bought: false, why: 'No label: from address missing line1, postalCode' })

        expect(aggregator.sent).toEqual([])
    })

    it('says why when the aggregator refuses, and records no Shipment', () => {
        aggregator.answer = { status: 400, body: JSON.stringify({ errors: [{ message: 'carrier account suspended' }] }) }

        expect(requestLabel()).toEqual({ bought: false, why: 'No label: HTTP 400: carrier account suspended' })

        expect(rows(SHIPMENTS)).toHaveLength(1)
        expect(returnOrder().work_notes ?? '').toBe('')
    })

    it('names the label bought, to be voided, when the platform refuses its Shipment', () => {
        platform.refuses = (table) => (table === SHIPMENTS ? 'shipment table is locked' : '')

        expect(requestLabel()).toEqual({
            bought: false,
            why: 'No label: the label bought (ups 1ZRET01, label se-123) was not recorded: shipment table is locked. Void it with the carrier',
        })

        expect(rows(SHIPMENTS)).toHaveLength(1)
        expect(platform.warnings).toEqual([
            expect.stringContaining('Label bought for RET0001 but no Shipment saved (ups 1ZRET01, label se-123): shipment table is locked'),
        ])
    })

    it('warns that a second label may have been bought when its lock was lost during the purchase', () => {
        // Another request takes the lock over as abandoned while the aggregator is called.
        aggregator.whileCalled = () => void (platform.tables[LOCKS] = [])

        expect(requestLabel()).toEqual({ bought: true, trackingNumber: '1ZRET01' })

        expect(rows(SHIPMENTS)).toHaveLength(2)
        expect(platform.warnings).toEqual([
            expect.stringContaining('Label ups 1ZRET01, label se-123 bought for RET0001 after its lock return_label_ret1 was lost: void any second label bought for it meanwhile'),
        ])
    })

    it('says where the label link is when the platform refuses the note on it', () => {
        platform.refuses = (table) => (table === RETURNS ? 'return is read only' : '')

        expect(requestLabel()).toEqual({
            bought: true,
            trackingNumber: '1ZRET01',
            unnoted: 'Return label 1ZRET01 created, but its work note was not saved (return is read only): its link is on the Shipment (https://labels.example/se-123.pdf)',
        })

        expect(rows(SHIPMENTS)).toHaveLength(2)
    })

    describe('whose label is marked voided', () => {
        beforeEach(() => {
            rows(SHIPMENTS).push(returnLabel())
        })

        it('is told not to ship on it, and can get a new label', () => {
            expect(voidLabel('shp2', '1ZOLD')).toEqual({ voided: true, message: 'Label 1ZOLD marked voided', leftUndone: false })

            expect(shipment('shp2')).toMatchObject({ status: 'voided', status_detail: 'Voided with the carrier (marked by Ada)' })
            expect(returnOrder().work_notes).toBe('Return label 1ZOLD voided with the carrier: do not ship on it.')
            expect(order()).toMatchObject({ tracking_number: '1Z999', carrier: 'ups' })
            expect(requestLabel()).toEqual({ bought: true, trackingNumber: '1ZRET01' })
        })

        it('is voided all the same when the platform refuses the note on it', () => {
            platform.refuses = (table) => (table === RETURNS ? 'return is read only' : '')

            expect(voidLabel('shp2', '1ZOLD')).toEqual({
                voided: true,
                message: 'Label 1ZOLD marked voided, but RET0001 was not noted (return is read only): tell the Site not to ship on it',
                leftUndone: true,
            })

            expect(shipment('shp2').status).toBe('voided')
        })
    })
})

describe("an Order's outbound label", () => {
    const LABEL = JSON.stringify({ label_id: 'se-456', tracking_number: '1ZNEW02', carrier_code: 'ups', label_download: { href: 'https://labels.example/se-456' }, shipment_cost: { amount: 30 } })

    /** The label bought as a Ship buys it: holding the Order's Ship lock. */
    function buy(packages: number) {
        const bought = withLock(LOCK.shipOrder('o1'), (lock) => labelOrder(record(ORDERS, 'o1'), packages, lock))
        return bought.ran ? bought.value : null
    }

    beforeEach(() => {
        aggregator.answer = { status: 200, body: LABEL }
        platform.properties = { [PROPERTY.shippingCarrierId.name]: 'se-carrier', [PROPERTY.stagingStockroom.name]: 'depot', [PROPERTY.shippingSenderPhone.name]: '+47 22 00 00 00' }
        platform.tables[SHIPMENTS] = []
        Object.assign(order(), { carrier: '', tracking_number: '' })
    })

    it('is bought from the depot to the Site, recorded as a Shipment, and its carrier and tracking number saved on the Order', () => {
        expect(buy(3)).toEqual({ ok: true, trackingNumber: '1ZNEW02', orderRefusal: '' })

        const sent = JSON.parse(aggregator.sent[0]?.body ?? '{}') as { shipment: { ship_from: Row; ship_to: Row; packages: Array<{ label_messages: Row }> } }
        expect(sent.shipment.ship_from).toMatchObject({ name: 'Central depot', phone: '+47 22 00 00 00', city_locality: 'Oslo' })
        expect(sent.shipment.ship_to).toMatchObject({ name: 'Acme HQ', company_name: 'Acme', city_locality: 'Bergen' })
        expect(sent.shipment.packages.map((box) => box.label_messages.reference1)).toEqual(['ORD0001', 'ORD0001', 'ORD0001'])
        expect(rows(SHIPMENTS)).toEqual([
            expect.objectContaining({ direction: 'to_site', order: 'o1', customer: 'acme', site: 'site1', packages: '3', tracking_number: '1ZNEW02', label_url: 'https://labels.example/se-456', cost: '30', currency: '', status: 'label_created' }),
        ])
        expect(order()).toMatchObject({ carrier: 'ups', tracking_number: '1ZNEW02' })
    })

    it('stands, and is reported, when the platform refuses to save it on the Order', () => {
        platform.refuses = (table) => (table === ORDERS ? 'order is read only' : '')

        expect(buy(1)).toEqual({ ok: true, trackingNumber: '1ZNEW02', orderRefusal: 'order is read only' })

        expect(rows(SHIPMENTS)).toHaveLength(1)
        expect(order().tracking_number).toBe('')
    })

    it('is not bought for more boxes than one label covers', () => {
        expect(buy(21)).toEqual({ ok: false, error: '21 packages is more than one label covers (20); enter the carrier and tracking number by hand' })

        expect(aggregator.sent).toEqual([])
        expect(rows(SHIPMENTS)).toEqual([])
    })

    it('is not bought while no depot is set', () => {
        delete platform.properties[PROPERTY.stagingStockroom.name]

        expect(buy(1)).toEqual({ ok: false, error: 'set x_daas_ham.staging.default_stockroom to the depot that ships' })

        expect(aggregator.sent).toEqual([])
    })

    it('is known as bought by its tracking number, unlike a number typed by hand', () => {
        buy(1)

        expect(orderLabelBought('o1', '1ZNEW02')).toBe(true)
        expect(orderLabelBought('o1', 'TYPED-BY-HAND')).toBe(false)
        expect(orderLabelBought('o2', '1ZNEW02')).toBe(false)
    })
})
```

**Verify**: `npx vitest run src/server/platform/shipping.test.ts` → `Tests  64 passed (64)`.

### Step 3: Run the gate and commit

**Verify**:

- `npm run typecheck` → exit 0.
- `npm run lint` → exit 0.
- `npm run check` → exit 0, and the test total is 64 higher than before this plan (1868 if nothing else landed since `805d5da`, where it was 1804).
- `git status --short` → only the new test file (and `plans/README.md` once you update it).

Then commit the file.

## Test plan

Every test is in the block above. The tables say what each one sets up beyond the shared fixture
and what it asserts, so that a failure can be reported by behaviour.

Shared fixture: the clock at 2026-11-10 09:00 UTC, the user Ada, Customer `acme`, Site `site1`
(Acme HQ, in Bergen) and the depot's location (in Oslo), stockroom `depot`, Order `ORD0001` (`o1`)
that tracks `ups 1Z999`, and one outbound Shipment `shp1` (`NSHP0001`) of that Order with status
`label_created`. `update({...})` builds a tracking update for `1Z999`: by default in transit,
"Arrived at hub", estimated 2026-11-12, with two events (picked up 08:00, at hub 14:00, both on
2026-11-10). `held(name)` stores a lock row, as another holder would.

Tracking (26 tests):

| Test | Setup | Asserts |
|---|---|---|
| applied | none | `{ outcome: 'applied', status: 'in_transit' }`. Shipment status, latest update and estimate set, no delivery time. Two events stored with time, status, description and location. Order not noted, no lock row left, nothing logged |
| unmatched | tracking number no Shipment has | `{ outcome: 'unmatched' }`, Shipment and events untouched |
| same update again | the update sent twice | applied both times, still two events |
| whole history again | then an update with a third event | out for delivery, estimate 2026-11-11, three events in order |
| event listed twice | one update with the same event twice | one event stored |
| older update after a newer one | out for delivery (event of 2026-11-11) applied first, then the in-transit update | outcome `applied` with status `out_for_delivery`. Status, latest update and estimate unchanged. The two older events are added |
| unknown status | an update of status `unknown` with one new event | status and latest update kept, three events |
| voided label | Shipment voided, then an `exception` update | status stays `voided`, latest update kept |
| delivery | delivered at 2026-11-11T10:15:00Z, four events | Shipment delivered with `delivered_at` 2026-11-11 10:15:00. Order work note `Delivered to Acme HQ (ups 1Z999).` |
| delivery noted once | delivered twice, the Order's note blanked between | the note stays blank after the second, delivery time unchanged, four events |
| no delivery time | delivered without `deliveredAt` | `delivered_at` is the clock, 2026-11-10 09:00:00 |
| older update after delivery | delivered, then the in-transit update | stays delivered |
| delivery after a newer event | an event of 2026-11-12 stored first, then the delivery | delivered all the same |
| returned after delivery | delivered, then `returned` | status `returned`, latest update `Returned to sender` |
| Order note refused | Order update refused | outcome applied, Shipment delivered, Order not noted, one warning naming `ORD0001` |
| delivery of a return label | the Shipment is a return label with no Order | applied, the Order of the fixture is not noted |
| Shipment save refused | Shipment update refused | `{ outcome: 'shipment_refused' }`, status unchanged, no event stored, one warning, no lock row left |
| event refused | insert of the "Arrived at hub" event refused | `{ outcome: 'events_refused', count: 1 }`, status saved, one event stored, one warning. Refusal lifted and the update sent again: applied, two events |
| lock held, queued | tracking lock of `shp1` held | `{ outcome: 'queued' }`. Nothing changed. One `x_daas_ham.shipment.track` event on `shp1` with parm2 `0`, not delayed. One info line |
| queued retry applies | the queued event's parm1 given to `retryTracking` once the lock is free | Shipment in transit with its estimate, two events, no further event queued |
| too long to queue | lock held, an event with a 4001-character time | `{ outcome: 'busy' }`, no event queued, one warning |
| retry still held off | lock held, `retryTracking(..., 3)` | one delayed event with the same parm1 and parm2 `4`, one info line "tried again in 60 s", Shipment unchanged |
| retry given up | lock held, `retryTracking(..., 15)` | no event, one warning "dropped after 15 tries" |
| retry, Shipment refused | Shipment update refused | one delayed event with parm2 `1`, info line "the platform refused the Shipment" |
| retry overtaken | out for delivery applied first, then the queued in-transit retry | status and latest update unchanged, three events, nothing queued |
| retry, not an update | parm1 `not json` | no event, one warning "parm1 is not an update" |

Marking a label voided (14 tests on an outbound label):

| Test | Setup | Asserts |
|---|---|---|
| voided and cleared | none | `voided: true`, `leftUndone: false`, the message naming `ORD0001`. Shipment voided, "marked by Ada". Order tracking number and carrier blank, with the work note of `voidedLabelOrderNote`. No lock row left, nothing logged |
| exception label | Shipment status `exception` | voided |
| Order tracks another label | Order tracking number `1Z777` | voided with the short message. Order unchanged and not noted |
| Ship lock held | `LOCK.shipOrder('o1')` held | `voided: false` with the "a Ship of its Order ..." text. Shipment and Order unchanged |
| tracking lock held | `LOCK.trackShipment('shp1')` held | `voided: false` with the "a tracking update of it is being saved. Try again" text. Shipment and Order unchanged. Only the held lock row is left |
| not voidable (six cases) | status in transit, out for delivery, delivered, returned, unknown, voided | `voided: false`, a message that ends "so it cannot be marked voided". Status and Order unchanged |
| Shipment gone | an id no Shipment has | `voided: false`, `Label 1Z999 no longer exists` |
| Shipment save refused | Shipment update refused | `voided: false` with the reason. Label still open, Order unchanged |
| Order save refused | Order update refused | `voided: true`, `leftUndone: true`, the message that says to clear the Order by hand. Shipment voided, Order still names the label |

A Return order's label (19 tests). Extra fixture: the aggregator answers 200 with label `se-123`,
tracking number `1ZRET01`, carrier `ups`, cost 12.5 `nok`. Return order `RET0001` (`ret1`) with two
lines awaiting and one received. The carrier account, the depot stockroom and the sender phone are
set as properties.

| Test | Setup | Asserts |
|---|---|---|
| bought | none | `{ bought: true, trackingNumber: '1ZRET01' }`. One call to the aggregator's `create_label`, from the Site (Acme HQ, Bergen) to the depot (Oslo), two packages. A return Shipment with customer, Site, stockroom, carrier, service `ups_standard`, 2 packages, label id, label link, cost 12.5, currency `NOK`, status `label_created`. The Return order's work note gives the link. No lock row left, nothing logged |
| nothing awaited | only a received line | `bought: false`, "Nothing on this return is still awaited", nothing sent |
| a label is open (five cases) | a return Shipment `1ZOLD` in status label created, exception, in transit, out for delivery, unknown | `bought: false` with that status's text of `returnLabelRefusal`. Nothing sent, no Shipment added |
| last label final (three cases) | the return Shipment voided, delivered or returned | a new label is bought |
| label lock held | `LOCK.returnLabel('ret1')` held | `bought: false`, "A return label is already being bought ...". Nothing sent, no Shipment added |
| no carrier account | the property removed | `bought: false`, "No label: set x_daas_ham.shipping.carrier_id ...". Nothing sent |
| Site without an address | street and postcode of the Site blank | `bought: false`, "No label: from address missing line1, postalCode". Nothing sent |
| aggregator refuses | the answer is 400 with an error message | `bought: false`, "No label: HTTP 400: carrier account suspended". No Shipment, Return order not noted |
| Shipment refused | Shipment insert refused | `bought: false`, the message that names the label bought and says to void it. No Shipment, one warning |
| lock lost during the purchase | the lock row removed while the aggregator is called | `bought: true`, the Shipment saved, one warning "bought for RET0001 after its lock return_label_ret1 was lost: void any second label bought for it meanwhile" |
| note refused | Return order update refused | `bought: true` with `unnoted` saying where the link is. The Shipment is saved |
| return label voided | the open label `shp2` marked voided | voided with the short message. Return order noted "do not ship on it". The Order of the fixture is untouched. A new label can then be bought |
| return label voided, note refused | Return order update refused | `voided: true`, `leftUndone: true`, the message that says to tell the Site |

An Order's outbound label (5 tests). `labelOrder` is called as Ship calls it, inside
`withLock(LOCK.shipOrder('o1'), ...)`. Extra fixture: the Order tracks nothing, no Shipment
stored, the aggregator answers 200 with label `se-456` and tracking number `1ZNEW02`.

| Test | Setup | Asserts |
|---|---|---|
| bought | three packages | `{ ok: true, trackingNumber: '1ZNEW02', orderRefusal: '' }`. Sent from the depot (with the sender phone) to the Site, three packages each with reference `ORD0001`. One outbound Shipment with 3 packages, cost 30, currency blank. Order carrier and tracking number saved |
| Order save refused | Order update refused | `ok: true` with `orderRefusal` the reason. The Shipment is saved, the Order's tracking number stays blank |
| more than 20 packages | 21 packages | `ok: false`, the "more than one label covers (20)" text. Nothing sent, no Shipment |
| no depot | the stockroom property removed | `ok: false`, "set x_daas_ham.staging.default_stockroom to the depot that ships". Nothing sent |
| bought or typed | one label bought | `orderLabelBought` is true for the bought number on `o1`, false for a typed number and false for another Order |

Structural patterns: `src/server/platform/returns.test.ts` and `src/server/platform/oem-sync.test.ts`.

## Done criteria

All local. No instance is needed. ALL must hold:

- [ ] `npx vitest run src/server/platform/shipping.test.ts` → 64 passed
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
- The drift check shows a change in a file under test and the excerpts in "Current state" no longer match.
- `npm run typecheck` or `npm run lint` reports an error in the new file after you copied it again from this plan.
- `npm run check` changes `src/fluent/generated/keys.ts`. This plan adds no metadata, so that change comes from somewhere else.
- `src/server/platform/shipping.test.ts` already exists.

## Maintenance notes

- These are characterization tests. When shipping behaviour changes on purpose, change the matching test in the same commit and say so in the commit body.
- Many tests assert a message word for word (what a user reads after Mark label voided or Create return label) or a fragment of a log line. If the wording changes, update the test.
- Not covered, and why:
  - Real concurrency. The fake runs one transaction at a time. The tests show that a held lock stops the work and that a second run repeats nothing. That the lock row excludes a second request on an instance rests on the unique index (ADR 0013).
  - A lock lost before the label is bought (the `lock.held()` check in `createShipment`). Nothing is saved between the take and that check, so the fake offers no moment to remove the lock. A lock lost during the purchase is covered.
  - `retryTracking` when `trackUnderLock` throws, and a retry whose events were refused.
  - An update too large for one event, shared out over several (`trackingRetryParams`). `src/server/domain/shipping.test.ts` covers the sharing.
  - The site contact's name and phone on a label (`siteContact`), and a `no response` from the aggregator. `restMessagePort` logs that case.
  - The display label of a status in the "cannot be marked voided" message. The fake gives the stored value.
- Plan 031 tests `shipOrder`, which calls `labelOrder`. The two test files stub the aggregator the same way and do not share code, on purpose: a test file here stands alone.
- At planning time each of these changes to `shipping.ts` made at least one of these tests fail: taking the status of an overtaken update, storing every event of an update again, noting every delivery, voiding without the Order's Ship lock, dropping the open-label check, buying a return label without its lock, voiding a label in any status, not clearing the Order, tracking without the tracking lock, storing events after a refused Shipment save, swapping sender and recipient, counting every Return line as a package, and not logging a label bought after its lock was lost. A reviewer can repeat any of them.
- A reviewer should check that the commit holds the test file and nothing else.
