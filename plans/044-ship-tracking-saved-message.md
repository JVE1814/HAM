# Plan 044: Link Ship's on-site work on the Order read again, so a refused tracking number stays unsaved

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- src/server/platform/delivery.ts src/server/platform/delivery.test.ts src/server/platform/shipping.ts src/server/test-support/fake-glide.ts docs/spec/p1-fulfilment.md`
> This plan lands after plans 030 and 031, so the check is expected to show
> `src/server/platform/delivery.test.ts` as a new file (plan 031 creates it).
> That is not a mismatch. Plan 030 creates `src/server/platform/shipping.test.ts`
> and changes none of the five paths. If `delivery.ts`, `shipping.ts` or
> `docs/spec/p1-fulfilment.md` changed, compare the "Current state" excerpts
> against the live code before proceeding. Only a mismatch in an excerpt this
> plan quotes is a STOP condition. A change to `fake-glide.ts` that only adds
> a method is not a mismatch.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/031-ship-order-tests.md` (it creates `src/server/platform/delivery.test.ts`,
  which this plan extends). Land after `plans/030-shipping-characterization.md` too: it pins
  `labelOrder`, which this plan leaves as it is.
- **Category**: bug
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

When the shipping aggregator is on, **Ship** buys a label and saves its carrier and tracking number
on the Order. If the platform refuses that save, Ship tells the user *Tracking number X not saved
on the Order* and goes on. Later in the same Ship it saves the Order again, to link the change
request and work order it opened at the Site. It uses the same in-memory record, which still holds
the refused carrier and tracking number, so that second save carries them along. Two things then
go wrong, both measured on the fake Glide:

- If the second save is accepted, the Order now holds the tracking number, and the user has just
  been told it was not saved.
- If the platform refuses the tracking number itself (a rule or data policy on that field), the
  second save is refused for the same reason. The on-site work is then not linked to the Order,
  although a save of the link alone would have been accepted. An unlinked work order is opened
  again by the next Ship, so the Site gets a second change and a second work order.

This plan makes the second save link the work on the Order read again. A refused tracking number
then stays unsaved, as the user was told, and it no longer costs the link.

## Current state

### The two saves of the Order in one Ship

`src/server/platform/shipping.ts` buys the label and makes the first save. It sets the two fields
on the record its caller handed in, and reports a refusal:

```ts
// src/server/platform/shipping.ts:147-153
export function labelOrder(order: GlideRecord, packages: number, lock: HeldLock): OrderLabel {
    const result = createShipment(SHIPMENT_DIRECTION.to_site, order, packages, lock)
    if (!result.ok) return result
    order.setValue('carrier', result.carrier)
    order.setValue('tracking_number', result.trackingNumber)
    return { ok: true, trackingNumber: result.trackingNumber, orderRefusal: order.update() ? '' : refusal(order) }
}
```

`src/server/platform/delivery.ts` calls it from `shipHolding`, reports the refusal and keeps using
the same `order`:

```ts
// src/server/platform/delivery.ts:108-113
    if (plan.labelPackages !== null) {
        const label = labelOrder(order, plan.labelPackages, lock)
        if (!label.ok) return { problems: [...problems, `No shipping label: ${label.error}`], shipped: null }
        // The label is paid for and its Shipment saved, so the units still ship; only the Order lacks its tracking.
        if (label.orderRefusal) problems.push(`Tracking number ${label.trackingNumber} not saved on the Order: ${label.orderRefusal}`)
    }
```

```ts
// src/server/platform/delivery.ts:127-133
    if (plan.onSiteWork) {
        const unopened = openOnSiteWork(order, plan.onSiteWork)
        if (unopened) problems.push(unopened)
    }
    recomputeOrder(order.getUniqueValue())
    return { problems, shipped: { units, siteName: str(order, 'site.name') } }
}
```

The second save is in `openOnSiteWork`. This is the function this plan changes:

```ts
// src/server/platform/delivery.ts:164-177
function openOnSiteWork(order: GlideRecord, work: OnSiteWork): string | null {
    const context: WorkContext = {
        customerId: str(order, 'customer'),
        siteId: str(order, 'site'),
        description: `${str(order, 'number')}: ${str(order, 'order_type')} at ${str(order, 'site.name')}`,
        sourceId: order.getUniqueValue(),
    }
    const opened = openFieldWork(context, work)
    if (!opened) return 'On-site work not opened (see the system log): open it by hand'
    order.setValue('change_request', opened.changeId)
    order.setValue('work_order', opened.workOrderId)
    // Unlinked, the next Ship opens the work again; the change and work order name the Order, to link them by hand.
    return order.update() ? null : `On-site work opened but not linked to the Order: ${refusal(order)}`
}
```

A record's `update()` saves every field that differs from what was read. After a refused save the
record still holds the values it tried to save. So the `order.update()` on the last line writes
`carrier` and `tracking_number` too, whenever `labelOrder`'s save was refused before it.

Nothing else in `shipHolding` saves `order`. `recomputeOrder` reads the Order again by its sys_id
(`src/server/platform/fulfilment.ts:167-168`). After the label step, `shipHolding` reads only
`number`, `site.name`, `customer`, `site` and `order_type` from `order`, none of which a Ship
changes. `findById` is already imported in `delivery.ts` (line 20) and already used in this file
to read the Order again (`shipOrder`, line 84).

### Why this fix, and what was passed over

- **Link the work on the Order read again (chosen).** `openOnSiteWork` reads the Order afresh with
  `findById` and sets the two links on that record. The save then holds the links only. A refused
  tracking number stays unsaved, so the message the user got is true in every case. A refusal of
  the tracking number no longer refuses the link. It is one function, and reading a record again
  before a save is what this file already does (`shipOrder`).
- **Decide the message from what is stored at the end of the Ship.** This would drop the message
  when the second save happened to write the number. It makes the message true, but the link save
  would still carry the refused fields. When the platform refuses the tracking number itself, the
  link would still be lost with it and the next Ship would still open the work twice. Passed over.
- **Try the tracking save a second time.** The first refusal was reported with its reason. A
  silent second try that sometimes succeeds makes the outcome depend on which save ran last.
  Passed over. The message names the tracking number, and the label's Shipment holds it, so the
  user can type it on the Order.
- **Set the fields back on the record in `labelOrder` after a refusal.** Whether a field set back
  to its old value counts as unchanged on an instance is not something the fake can show. A fresh
  read does not depend on it. Passed over.

What the user sees after this plan, for each kind of refusal of the first save:

| The first save is refused because | Before | After |
|---|---|---|
| of something that no longer holds at the second save | told *not saved*, yet the Order holds the number | told *not saved*, the Order does not hold it, the work is linked |
| the platform refuses the tracking number or carrier itself | told *not saved* and *not linked*, the next Ship opens the work again | told *not saved* only, the work is linked |
| the platform refuses every save of the Order | told *not saved* and *not linked* | the same (the link save is refused on its own account) |

The wording of the two messages does not change.

### The existing tests

Plan 031 creates `src/server/platform/delivery.test.ts` with 44 tests. Its describe
`Ship, with the shipping aggregator on` has 6 tests and this setup:

```ts
// src/server/platform/delivery.test.ts (plan 031), describe 'Ship, with the shipping aggregator on'
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
```

The describe ends with this test, followed by the next describe. These lines appear once in the
file, and step 2 inserts the new tests there:

```ts
// src/server/platform/delivery.test.ts (plan 031), end of 'Ship, with the shipping aggregator on'
        expect(rows(SHIPMENTS)).toHaveLength(1)
        expect(order().tracking_number).toBe('')
        expect(asset('a1')).toMatchObject(stage('shipped'))
        expect(asset('a2')).toMatchObject(stage('shipped'))
    })
})

describe('confirming an install', () => {
```

That last test (`ships the units, and reports each save of the Order the platform refuses`)
refuses every save of the Order and expects both messages. It must keep passing unchanged. So must
`is reported as not linked when the Order is refused, and the next Ship opens it again`.

How a test refuses a save on the fake (`src/server/test-support/fake-glide.ts:64`):
`platform.refuses = (table, row, operation) => 'why'`. `row` holds the values the save would
write, so a test can refuse a save by what it carries. `platform.onSave(table, row, operation)`
runs just before a row is stored, and a test uses it to land another transaction's write at that
moment. The fake runs no business rule, ACL or flow.

Plan 031's maintenance notes describe the first case of this bug as observed on the fake and not
pinned by a test. This plan pins it.

### Documentation to change

```md
<!-- docs/spec/p1-fulfilment.md:238-239 -->
- If the tracking number, or the change and work order, cannot be saved on the Order, Ship still
  ships and says so; the Shipment, change (its *Parent*) and work order (its *Initiated from*) name the Order, to link them by hand.
```

### Conventions that apply (README.md "Development", AGENTS.md)

- A test is a `*.test.ts` file beside the module it tests. A platform test runs against
  `src/server/test-support/fake-glide.ts`. The fake throws `fake Glide: ...` on anything it does
  not know.
- A relative import in `src/server` names the `.ts` file. This plan adds no import.
- `npx vitest run <path>` needs no build. `npm test` and `npm run check` do.
- `npm run build` rewrites the tracked file `src/fluent/generated/keys.ts`. This plan changes no
  Fluent file, so the build must leave it unchanged.
- Comments only for a non-obvious why. Use the words of `CONTEXT.md`: Order, Asset, Site.
- When documented behaviour changes, the matching spec line changes in the same commit.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| This plan's tests | `npx vitest run src/server/platform/delivery.test.ts` | all pass |
| Build | `npm run build` | exit 0; rewrites `dist/` |
| Full gate | `npm run check` | exit 0; all tests pass |

## Scope

**In scope** (the only files you should modify):

- `src/server/platform/delivery.ts` (only `openOnSiteWork`)
- `src/server/platform/delivery.test.ts` (three tests added)
- `docs/spec/p1-fulfilment.md` (one bullet extended)

**Out of scope** (do NOT touch, even though they look related):

- `src/server/platform/shipping.ts`. `labelOrder` keeps setting the fields on the record it is
  handed and keeps reporting `orderRefusal`. Plan 030 pins that.
- `src/server/platform/shipping.test.ts` (plan 030's file).
- `src/server/entry/delivery.ts`. `uiShipOrder` shows each problem as an error message, unchanged.
- The wording of `Tracking number ... not saved on the Order: ...` and of
  `On-site work opened but not linked to the Order: ...`. Tests of plan 031 assert both.
- `src/server/test-support/fake-glide.ts`. The tests need nothing the fake lacks.
- A second try of the tracking save, and any change to what Ship does when the label purchase
  itself fails.

## Git workflow

- Branch: `advisor/044-ship-tracking-saved-message`, from `main`.
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example
  `Link Ship's on-site work on the Order read again`. The body says what was wrong and why (the
  save that links the work wrote a tracking number the platform had just refused, or was refused
  for it and left the work unlinked).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Branch and confirm the baseline

```sh
git checkout main && git checkout -b advisor/044-ship-tracking-saved-message
npx vitest run src/server/platform/delivery.test.ts
npm run check
```

**Verify**: the first run reports `Tests  44 passed (44)`. `npm run check` exits 0. Write down the
total it prints on its `Tests` line as BASE (1848 when plan 031 alone landed on `805d5da`, more
with plan 030 and others). `git status --short` prints nothing afterwards. If
`src/server/platform/delivery.test.ts` does not exist, STOP: plan 031 has not landed.

### Step 2: Write the failing tests

Edit `src/server/platform/delivery.test.ts`. Find the lines quoted under "The existing tests" that
end the describe `Ship, with the shipping aggregator on`:

```ts
        expect(asset('a1')).toMatchObject(stage('shipped'))
        expect(asset('a2')).toMatchObject(stage('shipped'))
    })
})

describe('confirming an install', () => {
```

Insert two tests inside that describe, after the `    })` that closes its last test and before the
`})` that closes the describe. Leave one blank line before the first:

```ts
    it('leaves a refused tracking number off the Order when the save that links the on-site work is accepted', () => {
        let refusedOnce = false
        platform.refuses = (table) => {
            if (table !== ORDERS || refusedOnce) return ''
            refusedOnce = true
            return 'try again later'
        }

        expect(shipOrder('o1')).toEqual({
            problems: ['Tracking number 1ZNEW02 not saved on the Order: try again later'],
            shipped: { units: 2, siteName: 'Acme HQ' },
        })

        expect(order()).toMatchObject({ carrier: '', tracking_number: '', change_request: rows(CHANGES)[0]?.sys_id, work_order: rows(WORK_ORDERS)[0]?.sys_id })
        expect(rows(SHIPMENTS)).toEqual([expect.objectContaining({ order: 'o1', tracking_number: '1ZNEW02' })])
    })

    it('links the on-site work to an Order whose tracking number alone the platform refuses', () => {
        platform.refuses = (table, row) => (table === ORDERS && row.tracking_number ? 'tracking numbers are locked' : '')

        expect(shipOrder('o1')).toEqual({
            problems: ['Tracking number 1ZNEW02 not saved on the Order: tracking numbers are locked'],
            shipped: { units: 2, siteName: 'Acme HQ' },
        })

        expect(order()).toMatchObject({ carrier: '', tracking_number: '', work_order: rows(WORK_ORDERS)[0]?.sys_id })

        rows(ASSETS).push(unit('a3', 'staged'))
        shipOrder('o1')

        expect(rows(WORK_ORDERS)).toHaveLength(1)
    })
```

Then insert this describe after the `})` that closes `Ship, with the shipping aggregator on` and
before `describe('confirming an install', () => {`, with one blank line before and after it:

```ts
describe('on-site work opened for an Order that is gone by then', () => {
    it('is reported as not linked', () => {
        // Another transaction deletes the Order as the work order is saved.
        platform.onSave = (table) => {
            if (table === WORK_ORDERS) platform.tables[ORDERS] = []
        }

        expect(shipOrder('o1')).toEqual({
            problems: ['On-site work opened but not linked to the Order: the Order can no longer be read'],
            shipped: { units: 2, siteName: 'Acme HQ' },
        })

        expect(rows(WORK_ORDERS)).toHaveLength(1)
    })
})
```

What each test sets up. The first refuses the first save of the Order only, and accepts every
later one. The second refuses any save of the Order that carries a tracking number, as a rule on
that field would, and then ships a third Asset to show that no second work order is opened. The
third deletes the Order while the work order is being saved, so the read of the Order finds
nothing.

**Verify**: `npx vitest run src/server/platform/delivery.test.ts` → `3 failed | 44 passed (47)`.
The three failures are exactly the three new tests:

- `leaves a refused tracking number off the Order ...` fails on the Order's fields: it received
  `carrier: 'ups'` and `tracking_number: '1ZNEW02'` where it expected both blank. That is the bug.
- `links the on-site work to an Order whose tracking number alone the platform refuses` fails on
  the outcome: it received a second problem,
  `On-site work opened but not linked to the Order: tracking numbers are locked`.
- `on-site work opened for an Order that is gone by then > is reported as not linked` fails with
  the error `fake Glide: update of a x_daas_ham_order record that is not stored (sys_id "o1")`.
  That error is expected in this step only.

If the set of failures differs, STOP.

### Step 3: Link the work on the Order read again

Edit `openOnSiteWork` in `src/server/platform/delivery.ts`. Replace these four lines (173 to 176):

```ts
    order.setValue('change_request', opened.changeId)
    order.setValue('work_order', opened.workOrderId)
    // Unlinked, the next Ship opens the work again; the change and work order name the Order, to link them by hand.
    return order.update() ? null : `On-site work opened but not linked to the Order: ${refusal(order)}`
```

with:

```ts
    // Linked on the Order read again: `order` may still hold a carrier and tracking number the platform refused
    // (platform/shipping `labelOrder`). A save of `order` would write them too, after the user was told they were not
    // saved, or be refused for them and leave the work unlinked.
    const stored = findById('x_daas_ham_order', order.getUniqueValue())
    if (!stored) return 'On-site work opened but not linked to the Order: the Order can no longer be read'
    stored.setValue('change_request', opened.changeId)
    stored.setValue('work_order', opened.workOrderId)
    // Unlinked, the next Ship opens the work again; the change and work order name the Order, to link them by hand.
    return stored.update() ? null : `On-site work opened but not linked to the Order: ${refusal(stored)}`
```

Change nothing else in the file. The lines above them in `openOnSiteWork` (the `context`, the call
of `openFieldWork` and the `if (!opened)` line) stay as they are, and still read from `order`.
No import changes: `findById` and `refusal` are imported on line 20.

**Verify**:

- `npx vitest run src/server/platform/delivery.test.ts` → `Tests  47 passed (47)`.
- `grep -c "order.update()" src/server/platform/delivery.ts` → `0`.
- `grep -c "stored.update()" src/server/platform/delivery.ts` → `1`.
- `npm run typecheck` → exit 0. `npm run lint` → exit 0.

### Step 4: Say it in the spec

In `docs/spec/p1-fulfilment.md`, replace the two lines quoted under "Documentation to change"
(238 and 239) with:

```md
- If the tracking number, or the change and work order, cannot be saved on the Order, Ship still
  ships and says so; the Shipment, change (its *Parent*) and work order (its *Initiated from*) name the Order, to link them by hand.
  The two are saved apart, the change and work order on the Order read again: a tracking number
  the platform refused is not written by the later save, and does not keep that save from linking
  the change and work order.
```

**Verify**: `grep -c "The two are saved apart" docs/spec/p1-fulfilment.md` → `1`.

### Step 5: Run the full gate and commit

```sh
npm run check
git status --short
```

**Verify**: `npm run check` exits 0 and its `Tests` line reads BASE plus 3. `git status --short`
lists only the three in-scope files. If `src/fluent/generated/keys.ts` shows as modified, see the
STOP conditions.

Commit the three files in one commit, with the subject from "Git workflow" and a body that says
what was wrong and why.

## Test plan

- `src/server/platform/delivery.test.ts`, 3 tests added, in the style of plan 031's tests and on
  its fixture (Order `o1` with Assets `a1` and `a2` staged, the aggregator answering label
  `1ZNEW02`):
  - the first save of the Order refused and the later one accepted: one problem
    (`Tracking number 1ZNEW02 not saved on the Order: try again later`), 2 units shipped, the Order
    holds no carrier and no tracking number, it names the change and the work order, and the
    label's Shipment holds the tracking number. This is the regression test for the finding;
  - every save of the Order that carries a tracking number refused: the same single problem, the
    Order names the work order, and a second Ship of a third Asset opens no second work order;
  - the Order deleted while the work order is saved: the problem
    `On-site work opened but not linked to the Order: the Order can no longer be read`, 2 units
    shipped, one work order.
- The 44 tests of plan 031 stay unchanged and must pass. Two of them hold what must not change: a
  platform that refuses every save of the Order still gives both messages, and an unlinked work
  order is still opened again by the next Ship.
- Verification: `npx vitest run src/server/platform/delivery.test.ts` → 47 passed, 0 failed.

What the tests cannot show: the fake keeps a record's unsaved values after a refused `update()`
and writes them with the next one. The fake was built to keep the platform's behaviour there, but
no instance run of this case exists. The fix does not depend on it: a record read again holds only
what is stored, on the fake and on an instance alike.

ATF and instance checks: ATF runs on an instance only, and no ATF test refuses a save of an Order
during Ship. An instance check would need a before rule that refuses a tracking number. It is not
part of this plan. Say in your report that it was not run.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npx vitest run src/server/platform/delivery.test.ts` reports 47 passed, 0 failed
- [ ] `npm run check` exits 0 with BASE plus 3 tests passed
- [ ] `grep -c "order.update()" src/server/platform/delivery.ts` prints `0`
- [ ] `grep -c "The two are saved apart" docs/spec/p1-fulfilment.md` prints `1`
- [ ] `git diff --stat main..HEAD -- src/fluent src/server/platform/shipping.ts src/server/entry src/server/test-support` prints nothing
- [ ] `git status --short` is empty and only the three in-scope files differ from `main`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `src/server/platform/delivery.test.ts` does not exist, or step 1 does not report 44 passed.
  Plan 031 must land first.
- `openOnSiteWork` in `delivery.ts` does not match the excerpt under "Current state", or it
  already reads the Order again before it saves the links.
- `shipHolding` saves `order` somewhere else by now (`grep -n "order.update()" src/server/platform/delivery.ts`
  shows a line outside `openOnSiteWork`). That save would carry the refused fields too, and this
  plan does not cover it.
- Step 2 gives a different set of failing tests than the three listed, or the first two fail in
  another way than described.
- After step 3, one of plan 031's 44 tests fails. In particular
  `ships the units, and reports each save of the Order the platform refuses` must still get both
  messages. Do not edit an existing test to make it pass.
- After step 3, a test fails with a message that starts with `fake Glide:`. Report the message.
  Do not extend `fake-glide.ts` under this plan.
- The fix seems to need a change in `shipping.ts` or a new parameter on `shipOrder`.
- `npm run build` leaves `src/fluent/generated/keys.ts` modified. Report the diff.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- `labelOrder` still leaves the record it was handed holding a refused carrier and tracking
  number. `shipHolding` no longer saves that record. A new save added to `shipHolding` after the
  label step must read the Order again first, as `openOnSiteWork` now does, or it brings this bug
  back.
- A tracking number the platform refused is now never on the Order after the Ship. The message
  names it and the label's Shipment holds it, so the user types it on the Order. A later Ship
  counts a typed number that matches a bought label as bought (`orderLabelBought`), so nothing is
  bought twice for the same boxes.
- The new message `... the Order can no longer be read` shows when the Order is deleted, or hidden
  from the user, between the start of the Ship and the link. Ship holds the Order's Ship lock all
  that time, and Cancel order takes the same lock, so in practice only a delete by hand gets there.
  Before this plan that case called `update()` on a record that was no longer stored. The fake
  throws there, and its header comment says the platform would insert the record again. That
  comment is the only source for the platform's behaviour; it was not checked on an instance.
- Plan 031's maintenance note about this case ("observed while planning, on the fake, and not
  pinned by a test") is settled by this plan. Whoever edits that plan file next can drop the note.
- A reviewer should check three things: the two messages kept their wording, the lines of
  `openOnSiteWork` above the fresh read are unchanged, and the diff of `delivery.test.ts` only adds
  lines.
- Deferred: `labelOrder` could save the tracking number on a record of its own, so that it never
  leaves a caller's record holding refused values. It has one caller today, so the change is not
  needed yet. Take it up if a second caller appears.
