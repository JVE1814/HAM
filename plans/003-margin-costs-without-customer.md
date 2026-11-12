# Plan 003: Count a margin cost that names no Customer, and pin the margin writes with tests

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1864b17..HEAD -- src/server/platform/margin.ts src/server/platform/margin.test.ts src/server/domain/margin.ts src/server/test-support/fake-glide.ts docs/spec/p3-billing.md`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-lint-tracked-sources.md (so `npm run lint` is a usable gate)
- **Category**: bug
- **Planned at**: commit `1864b17`, 2026-11-12

## Why this matters

Margin is the management view of what each Customer costs the Provider. When a Billing period
closes, a job turns the month's Service intervals, field work orders and shipments into Cost facts
and Margin rows. A cost that cannot be costed is meant to be left out and counted on the period
(*Records that failed to cost*), so finance can see that the Margin is incomplete.

One case escapes that rule. A Service interval or a field work order that names no Customer has its
cost dropped without a count and without a log line. The Margin then reads as complete and too
high. This was reproduced: two provider-owned Assets with equal cost, one interval without a
Customer, gave one EUR 100 purchase fact instead of two, with `margin_failed` 0 and no error.

No test imports `src/server/platform/margin.ts` today. This plan first pins what the margin pass
writes with tests that pass on the current code, then adds the failing tests for the bug, then fixes
it. After it lands, such a record is counted on the period with a reason, like every other record
that fails to cost.

## Current state

Files and their roles:

- `src/server/platform/margin.ts`: the margin pass (Glide access). Contains both silent drops.
- `src/server/domain/margin.ts`: pure cost rules. `CostLedger.add` is where a cost without a
  Customer is dropped. This plan does not change it.
- `src/server/platform/margin.test.ts`: does not exist. This plan creates it.
- `src/server/test-support/fake-glide.ts`: the in-memory Glide every platform test runs against.
- `docs/spec/p3-billing.md`: the spec line that lists which records are counted as failed.

The drop, in the domain ledger:

```ts
// src/server/domain/margin.ts:120-124
    /** Add a cost (none without a Customer, or of 0); throws for one without a currency, which no Cost fact may hold. */
    add(entry: CostEntry): void {
        const { customerId, siteId, type, currency, amount } = entry
        if (!customerId || amount === 0) return
        if (!currency) throw new Error(`a ${type} cost has no currency`)
```

The Service interval pass. `handle` runs once per interval. What it throws is caught by the job
runner, counted as one failed record and reported as `<interval sys_id>: <message>`:

```ts
// src/server/platform/margin.ts:90-98
        handle: (interval) => {
            const asset = interval.asset
            // Its costs are not known, so it fails (counted on the period) rather than being costed at nothing.
            if (!asset) throw new Error(`its Asset ${interval.assetId || '(none)'} is not found, so its costs are not known`)
            // Its Subscription line's Agreement's currency: without one the interval fails (counted), as an unknown Asset does.
            const currency = currencyOrThrow(chooseCurrency(lineAgreements(interval.lineId), () => currencies(interval.customerId)))
            const costs = serviceIntervalCosts(interval, { ...asset, lease: (asset.leaseId ? leases(asset.leaseId) : null) }, bounds, amortisationMonths)
            for (const cost of costs) ledger.add({ customerId: interval.customerId, siteId: interval.siteId, currency, ...cost })
        },
```

`interval.customerId` is `str(interval, 'customer')` (`margin.ts:82`). An interval takes its
Customer from its Asset's `company` when it is opened (`src/server/platform/service-intervals.ts:79`),
so an Asset without a company gives an interval without a Customer.

The field labour pass. A work order with no `company` whose Order or Return order names an
Agreement gets a currency, then `ledger.add` drops it:

```ts
// src/server/platform/margin.ts:225-235
    while (workOrder.next()) {
        const customerId = str(workOrder, 'company')
        const currency = chooseCurrency(workOrderAgreement(workOrder), () => currencies(customerId))
        if ('problem' in currency) {
            result.failed++
            result.lastError = `work order ${str(workOrder, 'number')}: no currency: ${currency.problem}`
            continue
        }
        const amount = labourCost(str(workOrder, 'x_daas_ham_labour_cost'), visitCost)
        ledger.add({ customerId, siteId: str(workOrder, 'location'), type: 'field_labour', currency: currency.currency, amount })
    }
```

The precedent to match. The shipping pass already counts a shipment without a Customer:

```ts
// src/server/platform/margin.ts:262-272
    while (shipment.next()) {
        const currency = currencyCode(str(shipment, 'currency'))
        const customerId = str(shipment, 'customer')
        // CostLedger.add drops a cost without a Customer, so it is counted here rather than lost without a word.
        const missing = !currency ? 'its cost has no currency' : !customerId ? 'it has no Customer to cost it to' : ''
        if (missing) {
            result.failed++
            const name = str(shipment, 'number') || str(shipment, 'tracking_number') || shipment.getUniqueValue()
            result.lastError = `shipment ${name}: ${missing}`
            continue
        }
```

The spec line this plan extends:

```md
<!-- docs/spec/p3-billing.md:152-154 -->
- A Service interval whose Asset is gone, or whose currency is not known, a work order whose currency
  is not known, and a shipment with a cost but no currency are left out of Cost facts and Margin and
  counted on the period with the others (*Records that failed to cost*, below).
```

Facts about the job runner that the tests rely on:

- A margin pass runs as a chain of events. Each event runs one chunk through
  `computeMarginChunk` (`margin.ts:38`). A chunk ends when the job time budget
  (`x_daas_ham.job.budget_seconds`, `PROPERTY.jobBudgetSeconds`) is spent, never before it handled
  one record. With the budget set to `0`, each chunk handles one Service interval, so a pass over
  two intervals takes three chunks: one per interval and a last, empty one that completes the pass.
  The batch size does not cut chunks.
- Each chunk adds its sums to the period's Cost facts (`writeCostFacts`, `margin.ts:183`). A later
  chunk adds to the fact an earlier chunk wrote.
- Labour, shipping and the Margin rows are written once, when the pass completes
  (`complete`, `margin.ts:66-73`).
- Write-off: a provider-owned Asset costing 6000 is written off over 60 months
  (`PROPERTY.amortisationMonths`), so 100 for a full month. A work order with a blank labour cost
  costs the standard visit, 250 (`PROPERTY.visitCost`).

Conventions that apply (README.md "Development"):

- A test is a `*.test.ts` file beside the module it tests.
- A platform test runs against `test-support/fake-glide.ts`. It mocks Glide with
  `vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)`.
  The fake throws `fake Glide: ...` on anything it does not know, so no test passes on a guess.
  Model the file on `src/server/platform/chunked.test.ts` and `src/server/entry/billing.test.ts`.
- A relative import in `src/server` names the `.ts` file (ESLint enforces it).
- `src/server/built-metadata.test.ts` fails when a file under `src/server` is newer than `dist/app`.
  Run `npm run build` before the full test run.
- Comments only for a non-obvious why. No comment that narrates a step.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 (needs plan 001; before it, use `npx eslint src`) |
| This plan's tests | `npx vitest run src/server/platform/margin.test.ts` | all pass |
| Build | `npm run build` | exit 0; rewrites `dist/` |
| Full gate | `npm run check` | exit 0; all tests pass |

## Scope

**In scope** (the only files you should modify):

- `src/server/platform/margin.test.ts` (create)
- `src/server/platform/margin.ts`
- `docs/spec/p3-billing.md`

**Out of scope** (do NOT touch, even though they look related):

- `src/server/domain/margin.ts`. `CostLedger.add` keeps dropping a cost without a Customer. Its
  doc comment says so and the shipping pass relies on checking first. Changing the ledger changes
  the domain contract and its tests.
- `src/server/platform/service-intervals.ts`. Why an interval is opened without a Customer is a
  data question (an Asset with no company). This plan makes the gap visible. It does not prevent it.
- `src/server/test-support/fake-glide.ts`. If a test needs a Glide method the fake lacks, that is a
  STOP condition, not a reason to extend the fake here.
- `addShippingCosts` in `margin.ts`. It is already right.

## Git workflow

- Branch: `advisor/003-margin-costs-without-customer`, from `main`.
- Two commits, in this order. Subjects are imperative sentences under 72 characters, in the repo's
  style (examples from `git log`: `Refuse a server module that is not a .ts file`,
  `Sort the fake platform's rows with the comparison its filters use`). The body says what was
  wrong and why.
  1. `Pin the margin pass's Cost facts and Margin rows with tests` (step 2).
  2. `Count a margin cost that names no Customer` (steps 3 to 5).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Branch and confirm the baseline

```sh
git checkout main && git checkout -b advisor/003-margin-costs-without-customer
npx vitest run src/server/domain
```

**Verify**: the vitest run reports all tests passed, 0 failed.

### Step 2: Create the test file with the characterization tests

Create `src/server/platform/margin.test.ts` with exactly this content:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlideRecord } from '@servicenow/glide'
import { EVENT } from '../domain/events.ts'
import { PROPERTY } from '../domain/properties.ts'
import { computeMarginChunk } from './margin.ts'
import { platform, recordOf, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const PERIOD = 'x_daas_ham_billing_period'
const INTERVAL = 'x_daas_ham_service_interval'
const FACT = 'x_daas_ham_cost_fact'
const MARGIN = 'x_daas_ham_margin'
const WORK_ORDER = 'wm_order'
const SHIPMENT = 'x_daas_ham_shipment'

const rows = (table: string): Row[] => platform.tables[table] ?? []
const periodRow = (): Row => rows(PERIOD)[0] ?? {}
const facts = () => rows(FACT).map((fact) => [fact.customer, fact.site, fact.cost_type, fact.currency, fact.amount])
const margins = () => rows(MARGIN).map((row) => [row.customer, row.site, row.currency, row.revenue, row.cost, row.margin, row.margin_pct])

/** Run a margin pass of the period to its end, a chunk per event, as the script action does. How many chunks ran. */
function computeMargin(): number {
    const period = recordOf<GlideRecord>(PERIOD, periodRow())
    computeMarginChunk({ name: EVENT.marginCompute, record: period, subject: 'p10', position: '' })
    let chunks = 1
    for (let event = platform.events.shift(); event; event = platform.events.shift()) {
        computeMarginChunk({ name: event.name, record: period, subject: event.parm1, position: event.parm2 })
        chunks++
    }
    return chunks
}

/** A provider-owned Asset bought for 6000: written off over 60 months, 100 for each full month in service. */
function asset(id: string): Row {
    return { sys_id: id, x_daas_ham_legal_owner: 'provider', cost: '6000', purchase_date: '2026-01-01', x_daas_ham_fleet: 'true' }
}

/** A Service interval of acme at Site s1, open through October 2026. */
function interval(id: string, assetId: string, fields: Row = {}): Row {
    return { sys_id: id, asset: assetId, subscription_line: 'sub1', customer: 'acme', site: 's1', start_date: '2026-09-01', end_date: '', ...fields }
}

/** A field work order of acme at Site s1, closed in October 2026. */
function workOrder(id: string, fields: Row = {}): Row {
    return { sys_id: id, number: id.toUpperCase(), x_daas_ham_purpose: 'install', closed_at: '2026-10-15 10:00:00', company: 'acme', location: 's1', initiated_from: '', x_daas_ham_labour_cost: '', ...fields }
}

/** A Shipment of acme to Site s1 whose label was bought in October 2026. */
function shipment(id: string, fields: Row = {}): Row {
    return { sys_id: id, number: id.toUpperCase(), status: 'delivered', cost: '40', currency: 'USD', customer: 'acme', site: 's1', sys_created_on: '2026-10-05 09:00:00', ...fields }
}

beforeEach(() => {
    platform.reset()
    platform.clock = Date.parse('2026-11-11T12:00:00Z')
    platform.uniqueKeys = { x_daas_ham_job_lock: 'name', x_daas_ham_job_cursor: 'job' }
    // No time to spare: each chunk pauses after one Service interval, so a pass of two takes several chunks.
    platform.properties = { [PROPERTY.jobBudgetSeconds.name]: '0' }
    platform.references = {
        'x_daas_ham_subscription_line.agreement': 'x_daas_ham_agreement',
        'x_daas_ham_order.agreement': 'x_daas_ham_agreement',
    }
    platform.tables[PERIOD] = [{ sys_id: 'p10', period: '2026-10', status: 'closed', margin_failed: '0', margin_error: '' }]
    platform.tables.x_daas_ham_agreement = [{ sys_id: 'ag1', number: 'NAG0001', currency: 'EUR', customer: 'acme' }]
    platform.tables.x_daas_ham_subscription_line = [{ sys_id: 'sub1', agreement: 'ag1', customer: 'acme' }]
    platform.tables.x_daas_ham_order = [{ sys_id: 'ord1', agreement: 'ag1' }]
    platform.tables.alm_hardware = [asset('a1'), asset('a2')]
    platform.tables[INTERVAL] = [interval('i1', 'a1'), interval('i2', 'a2')]
})

describe('the margin of a closed Billing period', () => {
    it('adds the costs of every chunk to one Cost fact per Customer, Site, type and currency, and sets them against the revenue', () => {
        platform.tables[WORK_ORDER] = [workOrder('wo1', { x_daas_ham_labour_cost: '80' }), workOrder('wo2')]
        platform.tables[SHIPMENT] = [shipment('sh1'), shipment('sh2', { status: 'voided', cost: '99' })]
        platform.tables.x_daas_ham_billing_line = [{ sys_id: 'bl1', billing_period: 'p10', customer: 'acme', site: 's1', currency: 'EUR', amount: '500' }]

        // A chunk per Service interval, and the last, empty one that completes the pass.
        expect(computeMargin()).toBe(3)

        expect(facts()).toEqual([
            ['acme', 's1', 'purchase', 'EUR', '200'],
            ['acme', 's1', 'field_labour', 'EUR', '330'],
            ['acme', 's1', 'shipping', 'USD', '40'],
        ])
        expect(margins()).toEqual([
            ['acme', 's1', 'EUR', '500', '530', '-30', '-6'],
            ['acme', 's1', 'USD', '0', '40', '-40', ''],
        ])
        expect(periodRow()).toMatchObject({ margin_failed: '0', margin_error: '' })
        expect(rows('x_daas_ham_job_lock')).toEqual([])
    })

    it('replaces the Cost facts and Margin of an earlier pass', () => {
        computeMargin()
        computeMargin()

        expect(facts()).toEqual([['acme', 's1', 'purchase', 'EUR', '200']])
        expect(margins()).toEqual([['acme', 's1', 'EUR', '0', '200', '-200', '']])
    })

    it('leaves out a Service interval whose Asset is gone and a shipment without a currency, and counts both on the period', () => {
        platform.tables.alm_hardware = [asset('a1')]
        platform.tables[SHIPMENT] = [shipment('sh1', { currency: '' })]

        computeMargin()

        expect(facts()).toEqual([['acme', 's1', 'purchase', 'EUR', '100']])
        expect(periodRow()).toMatchObject({ margin_failed: '2', margin_error: 'shipment SH1: its cost has no currency' })
        expect(platform.logs).toContainEqual(expect.stringContaining('i2: its Asset a2 is not found'))
    })

    it('computes nothing for a period that is not closed', () => {
        periodRow().status = 'ready'

        expect(computeMargin()).toBe(1)

        expect(rows(FACT)).toEqual([])
        expect(rows(MARGIN)).toEqual([])
    })
})
```

Do not change `src/server/platform/margin.ts` in this step. These tests describe the current
behaviour and must pass on the unchanged code.

**Verify**: `npx vitest run src/server/platform/margin.test.ts` → `4 passed`, 0 failed.

Then commit:

```sh
git add src/server/platform/margin.test.ts
git commit -m "Pin the margin pass's Cost facts and Margin rows with tests" -m "No test imported platform/margin.ts. These run a pass over several chunks on the fake Glide and hold what it writes: one Cost fact per Customer, Site, type and currency with the chunks' sums, Margin rows against the revenue per currency, a voided label left out, and the failed records counted on the period."
```

### Step 3: Add the failing tests for the bug

Append this block to the end of `src/server/platform/margin.test.ts`:

```ts
describe('a cost that names no Customer', () => {
    it("is counted on the period when it is a Service interval's, not left out without a word", () => {
        platform.tables[INTERVAL] = [interval('i1', 'a1'), interval('i2', 'a2', { customer: '' })]

        computeMargin()

        expect(facts()).toEqual([['acme', 's1', 'purchase', 'EUR', '100']])
        expect(periodRow()).toMatchObject({ margin_failed: '1', margin_error: 'i2: it names no Customer to cost it to' })
    })

    it("is counted on the period when it is a work order's", () => {
        platform.tables[WORK_ORDER] = [workOrder('wo1', { company: '', initiated_from: 'ord1' })]

        computeMargin()

        expect(facts()).toEqual([['acme', 's1', 'purchase', 'EUR', '200']])
        expect(periodRow()).toMatchObject({ margin_failed: '1', margin_error: 'work order WO1: it has no Customer to cost it to' })
    })
})
```

**Verify**: `npx vitest run src/server/platform/margin.test.ts` → `2 failed | 4 passed`. Both
failures are in `a cost that names no Customer`, and each shows `margin_failed: "0"` received where
`"1"` was expected. That is the bug. If the two new tests pass, or any of the first four fails, STOP.

### Step 4: Count both records instead of dropping them

Edit `src/server/platform/margin.ts`. Two changes.

In `costServiceIntervals`, inside `handle`, add two lines right after the `if (!asset) throw ...`
line (line 93):

```ts
            if (!asset) throw new Error(`its Asset ${interval.assetId || '(none)'} is not found, so its costs are not known`)
            // CostLedger.add drops a cost without a Customer, so the interval fails (counted) rather than being left out without a word.
            if (!interval.customerId) throw new Error('it names no Customer to cost it to')
```

In `addFieldLabour`, add the check right after `const customerId = str(workOrder, 'company')`
(line 226), before the currency is chosen:

```ts
        const customerId = str(workOrder, 'company')
        // Counted, as a shipment's is (addShippingCosts): CostLedger.add would drop its cost without a word.
        if (!customerId) {
            result.failed++
            result.lastError = `work order ${str(workOrder, 'number')}: it has no Customer to cost it to`
            continue
        }
        const currency = chooseCurrency(workOrderAgreement(workOrder), () => currencies(customerId))
```

Change nothing else in the file. The messages must match the tests character for character.

**Verify**: `npx vitest run src/server/platform/margin.test.ts` → `6 passed`, 0 failed.

### Step 5: Update the spec line

In `docs/spec/p3-billing.md`, replace the three lines quoted under "Current state" (lines 152-154)
with:

```md
- A Service interval whose Asset is gone, whose currency is not known or that names no Customer, a
  work order whose currency is not known or that has no Customer, and a shipment with a cost but no
  currency or no Customer are left out of Cost facts and Margin and counted on the period with the
  others (*Records that failed to cost*, below).
```

**Verify**: `grep -n "names no Customer" docs/spec/p3-billing.md` → one match.

### Step 6: Run the full gate and commit

```sh
npm run check
git status --short
```

**Verify**: `npm run check` exits 0. `git status --short` lists only
`src/server/platform/margin.test.ts`, `src/server/platform/margin.ts` and
`docs/spec/p3-billing.md`. If `src/fluent/generated/keys.ts` shows as modified, see the STOP
conditions.

```sh
git add src/server/platform/margin.test.ts src/server/platform/margin.ts docs/spec/p3-billing.md
git commit -m "Count a margin cost that names no Customer" -m "A Service interval or a field work order that named no Customer had its cost dropped by CostLedger.add with no count and no log, so the period's Margin read as complete. Each now fails to cost and is counted on the period with the reason, as a shipment without a Customer already was."
```

## Test plan

New file `src/server/platform/margin.test.ts`, six tests, modelled on
`src/server/platform/chunked.test.ts` (fake Glide setup) and `src/server/entry/billing.test.ts`
(draining queued events):

- Characterization, green before the fix:
  - a pass over three chunks writes one Cost fact per Customer, Site, type and currency with the
    summed amount (purchase 200, field labour 330, shipping 40 USD), leaves a voided label out,
    writes one Margin row per currency against the revenue, counts no failure and releases its lock;
  - a second pass replaces the first pass's Cost facts and Margin;
  - an interval whose Asset is gone and a shipment without a currency are left out and counted (2);
  - a period that is not closed gets nothing.
- The regression, red before the fix:
  - a Service interval that names no Customer is counted, with `i2: it names no Customer to cost it to`;
  - a work order with no Customer is counted, with `work order WO1: it has no Customer to cost it to`.

Verification: `npx vitest run src/server/platform/margin.test.ts` → 6 passed.

All of this runs locally. No instance is needed.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npx vitest run src/server/platform/margin.test.ts` reports 6 passed
- [ ] `npm run check` exits 0
- [ ] `grep -c "no Customer to cost it to" src/server/platform/margin.ts` prints `3` (the interval, the work order, the shipment)
- [ ] `git diff --stat 1864b17..HEAD -- src/server/domain/margin.ts` prints nothing
- [ ] `git status --short` is empty and `git log --oneline main..HEAD` shows the two commits
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts.
- Any of the four characterization tests fails on the unchanged `margin.ts` in step 2. They
  describe current behaviour. A failure means the code or the fake has drifted. Do not edit the
  expectations to make them pass.
- A test fails with a message that starts with `fake Glide:`. The fake lacks something the pass
  needs. Report the message. Do not extend `fake-glide.ts` under this plan.
- In step 3 the two new tests do not fail the way the step describes.
- The fix seems to need a change in `src/server/domain/margin.ts` or in any file outside the scope.
- `npm run build` leaves `src/fluent/generated/keys.ts` modified. This plan adds no Fluent record,
  so the file should not change. Report the diff.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- `CostLedger.add` still drops a cost without a Customer. Any new cost source added to
  `platform/margin.ts` must check for a Customer before it calls `add`, as the three passes now do.
  Making `add` throw instead was considered and left out: it changes the domain contract, and the
  labour and shipping passes would still need their own check, because a throw there stops the
  whole pass instead of counting one record.
- A work order with no Customer and no Agreement was already counted, as *no currency*. It is now
  counted as *it has no Customer to cost it to*. The count is the same, the reason is clearer.
- The root data gap is not fixed here. An interval has no Customer when its Asset had no `company`
  as the interval was opened (`platform/service-intervals.ts:79`). If the period count shows such
  records in practice, the follow-up is to find how a fleet asset goes into service with no company.
- A reviewer should check that the two new messages match the tests exactly and that no other line
  of `margin.ts` changed.
- The characterization tests use a job time budget of 0 to cut the pass into chunks. If the chunk
  runner changes how it pauses (`domain/chunked-job.ts` `runChunked`), the chunk count in the first
  test changes with it.
