# Plan 016: Test lease decisions and disposal orders on the fake Glide

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1864b17..HEAD -- src/server/platform/leases.ts src/server/platform/disposal.ts src/server/platform/stock.ts src/server/platform/approvals.ts src/server/platform/chunked.ts src/server/domain/leases.ts src/server/domain/disposal.ts src/server/test-support/fake-glide.ts src/server/platform/lease-decisions.test.ts src/server/platform/disposal.test.ts`
> The first eight paths are the code under test and the fake it runs on. The
> last two are the files you create, and must not exist yet. If any of the
> eight changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding. On a mismatch, treat it
> as a STOP condition. Plan 008 adds a run lock to `runLeaseReview` in
> `leases.ts`. That function is not under test here, so that change alone is
> not a mismatch.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/001-lint-tracked-sources.md
- **Category**: tests
- **Planned at**: commit `1864b17`, 2026-11-12

## Why this matters

An end-of-lease decision and a Disposal order both change who owns equipment and take it out of
service for good. A buy-out makes the Provider the owner of every Asset on the lease and writes each
one's cost for Margin. A return withdraws stock onto a disposal. Completing a disposal retires
Assets. No test imports `src/server/platform/leases.ts` or `src/server/platform/disposal.ts`. ATF
covers only lease ownership and a lease extension (`src/fluent/leases/tests.now.ts:19` and `:63`),
and disposal has no ATF test at all. The branches that handle a refused save, a held stock lock or
a second run are the ones nobody has run.

This plan adds 49 unit tests that pin what the code does today. It changes no behaviour. The tests
were written against commit `1864b17` and all pass there, so **a test that fails on the current
code is a finding to report, not a defect to fix in this plan**.

## Current state

Files and their roles:

- `src/server/platform/leases.ts`. `applyLeaseDecision` applies a buy-out, an extension or a return. `transferToProvider` is the buy-out's background job. Not changed.
- `src/server/platform/disposal.ts`. `submitDisposal` puts a draft order to approval. `completeDisposal` retires each line's Asset. Not changed.
- `src/server/domain/leases.ts` and `src/server/domain/disposal.ts`. The pure rules. Already unit-tested.
- `src/server/test-support/fake-glide.ts`. The in-memory Glide the tests run on. Not changed.
- `src/server/platform/lease-decisions.test.ts` and `src/server/platform/disposal.test.ts`. Do not exist. You create them.

The lease test file is named after its topic, not `leases.test.ts`, on purpose. Plan 008 creates
`src/server/platform/leases.test.ts` for the run lock it adds to `runLeaseReview`, and the two plans
can land in either order. A topic-named test file beside its module has precedent:
`src/server/platform/receiving-serial.test.ts` and `receiving-order-line.test.ts` both test
`receiving.ts`. If `leases.test.ts` exists when you start, leave it alone.

The decision is closed before the lease is saved, and reopened when that save is refused:

```ts
// src/server/platform/leases.ts:170-172
    const openState = str(decisionRecord, 'state')
    decisionRecord.setValue('state', TASK_STATE.closedComplete)
    if (!decisionRecord.update()) return notApplied()

// src/server/platform/leases.ts:189-192
    if (!lease.update()) {
        // Refused: no transfer or return may act on a decision the lease does not record, so the decision opens again.
        return notApplied(reopenDecision(decisionRecord, openState, `Lease ${str(lease, 'number')} not saved: ${refusal(lease)}`))
    }
```

A return withdraws each stock unit under its stock lock, from a fresh read:

```ts
// src/server/platform/leases.ts:270-279
function withdrawFromStock(found: GlideRecord): GlideRecord | 'taken' | 'refused' {
    const withdrawn = changeStock(found.getUniqueValue(), 'withdrawn for its lessor', (asset, lock) => {
        if (!asset || !isFree(stockUnit(asset), STOCK_STAGES)) return 'taken'
        return moveOutOfStock(lock, asset) ? asset : 'refused'
    })
    if (withdrawn.ran) return withdrawn.value
    const serial = str(found, 'serial_number')
    log.warn(`Lease return: ${serial} not withdrawn: its stock lock could not be taken`)
    return 'refused'
}
```

The buy-out's job writes the owner, and the cost when the buy-out has a price:

```ts
// src/server/platform/leases.ts:319-329
        handle: (assetId) => {
            const asset = findById('alm_hardware', assetId)
            if (!asset || str(asset, 'x_daas_ham_lease') !== leaseId || isRetired(readStage(asset))) return
            asset.setValue('x_daas_ham_lease', '')
            asset.setValue('x_daas_ham_legal_owner', LEGAL_OWNER.provider)
            const purchase = buyoutPurchase(buyoutCost(split, assetId), today)
            if (purchase) {
                asset.setValue('cost', purchase.cost)
                asset.setValue('purchase_date', purchase.date)
            }
            if (asset.update()) return
```

Completing a disposal skips a line already done, and keeps the order open while a line is blocked or unsaved:

```ts
// src/server/platform/disposal.ts:122-140
    while (line.next()) {
        if (choice<DisposalLineStatus>(line, 'status') === DISPOSAL_LINE_STATUS.done) continue
        const blockers = retire(line, order)
        if (blockers) blocked++
        const status = blockers ? DISPOSAL_LINE_STATUS.blocked : DISPOSAL_LINE_STATUS.done
        line.setValue('status', status)
        line.setValue('blockers', blockers)
        if (line.update()) continue
        // A line not saved as done keeps the order open: its Asset may be retired already, so it is set done by hand.
        unsaved++
        const what = `${str(order, 'number')} line for ${line.getDisplayValue('asset')}`
        warnRefused(line, `${what} not saved (${blockers ? 'blocked' : 'done, its asset retired'})`)
    }
    if (blocked > 0 || unsaved > 0) return { completed: false, blocked, unsaved }
    order.setValue('stage', DISPOSAL_STAGE.completed)
    order.setValue('state', TASK_STATE.closedComplete)
    if (order.update()) return { completed: true, blocked, unsaved }
    // Refused, it stays open with every line done: completing it again retires nothing twice and closes it.
    return { completed: false, blocked, unsaved, refused: refusal(order) }
```

Conventions that apply (from `README.md` "Development", lines 308-323):

- A test is a `*.test.ts` file beside the module it tests. The build leaves it out of the app.
- A relative import in `src/server` names the `.ts` file (`'./leases.ts'`, not `'./leases'`).
- A platform test runs against `test-support/fake-glide.ts`. Each test file mocks Glide with this exact line, after its imports:
  `vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)`
- Model the structure on `src/server/platform/returns.test.ts` and `src/server/platform/approvals.test.ts`.

What the tests rely on in the fake (`src/server/test-support/fake-glide.ts`):

- `platform.reset()` clears everything. `platform.tables[table]` holds the stored rows, and a test seeds and reads them directly.
- A field that was never set to a non-blank value is absent from the stored row. That is why some assertions read `row.field ?? ''`.
- `update()` saves only when a field changed. A test that needs the first save of a form to be refused sets a field on the record first.
- `platform.uniqueKeys = { x_daas_ham_job_lock: 'name' }` makes a second lock row with the same name be refused, which is how a job lock is held (ADR 0013). A test holds a lock by seeding its row.
- `platform.refuses(table, row, operation)` returns why a save is refused. `platform.onSave(table, row, operation)` runs just before a row is stored, and a test uses it to land "another transaction's" write at that moment.
- `platform.events` lists the events queued with `gs.eventQueue`. `platform.defaults[table]` fills in what the platform would on insert (a number).
- A dot-walk through a reference the test did not declare in `platform.references` throws an error that starts with `fake Glide:`.
- A reference's display value is the referenced row's `display_name`, `number`, `name` or `sys_id`, the first that is set.
- The fake runs no business rule, ACL or flow.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| One test file | `npx vitest run src/server/platform/lease-decisions.test.ts` | all pass |
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 (needs plan 001; before it, use `npx eslint src`) |
| Full gate | `npm run check` | typecheck, lint, build and all tests pass |

`npm run check` runs `npm run build`, which rewrites `dist/` and may rewrite the tracked
`src/fluent/generated/keys.ts`. This plan adds no metadata, so `git status --short` must show no
change to `keys.ts` afterwards.

## Scope

**In scope** (the only files you create or modify):

- `src/server/platform/lease-decisions.test.ts` (create)
- `src/server/platform/disposal.test.ts` (create)
- `plans/README.md` (your status row only)

**Out of scope** (do NOT touch):

- `src/server/platform/leases.ts`, `src/server/platform/disposal.ts` and every other non-test file. This plan changes no behaviour, even where a test shows behaviour you think is wrong.
- `src/server/test-support/fake-glide.ts`. If the fake lacks something, stop.
- Tests of `runLeaseReview`. Plan 008 changes that function and tests it.
- ATF tests for leases or disposal.

## Git workflow

- Branch: `advisor/016-lease-disposal-characterization`
- One commit. Subject in the repo's style (an imperative sentence under 72 characters), for example:
  `Test lease decisions and disposal orders`
  The body says that no test imported `platform/leases.ts` or `platform/disposal.ts`, and that the tests pin the behaviour as it is at `1864b17`.
- Do NOT push or open a PR unless the operator told you to.

## Steps

### Step 1: Record the baseline

Run the existing platform tests and note the totals.

**Verify**: `npx vitest run src/server/platform` → all pass. `ls src/server/platform/lease-decisions.test.ts src/server/platform/disposal.test.ts` → both "No such file".

### Step 2: Create the lease tests

Create `src/server/platform/lease-decisions.test.ts` with exactly this content:

```ts
import { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EVENT } from '../domain/events.ts'
import { fieldsOf, type Stage } from '../domain/lifecycle.ts'
import { LOCK } from '../domain/lock-names.ts'
import { applyLeaseDecision, transferToProvider } from './leases.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const ASSETS = 'alm_hardware'
const LEASES = 'x_daas_ham_lease_schedule'
const DECISIONS = 'x_daas_ham_lease_decision'
const DISPOSALS = 'x_daas_ham_disposal_order'
const DISPOSAL_LINES = 'x_daas_ham_disposal_line'
const LOCKS = 'x_daas_ham_job_lock'

const rows = (table: string): Row[] => platform.tables[table] ?? []
const asset = (id: string): Row => rows(ASSETS).find((row) => row.sys_id === id) ?? {}
const lease = (): Row => rows(LEASES)[0] ?? {}
const decisionRow = (): Row => rows(DECISIONS)[0] ?? {}

function stage(of: Stage): Row {
    const { installStatus, substatus } = fieldsOf(of)
    return { install_status: installStatus, substatus: substatus ?? '' }
}

function leased(id: string, of: Stage, fields: Row = {}): Row {
    return {
        sys_id: id,
        serial_number: `FOC-${id}`,
        x_daas_ham_fleet: 'true',
        x_daas_ham_lease: 'lease1',
        x_daas_ham_legal_owner: 'lessor',
        company: 'provider-co',
        cost: '900',
        purchase_date: '2024-01-01',
        ...stage(of),
        ...fields,
    }
}

/** The decision as its form sends it: stored open, with `chosen` set on the record and not saved yet. */
function decide(chosen: Row): GlideRecord {
    const record = new GlideRecord(DECISIONS)
    record.get('dec1')
    for (const [field, value] of Object.entries(chosen)) record.setValue(field, value)
    return record
}

function record(table: string, id: string): GlideRecord {
    const found = new GlideRecord(table)
    found.get(id)
    return found
}

/** Run every chunk the buyout queued, as its script action would. */
function runBuyout(): void {
    for (let event = platform.events.shift(); event; event = platform.events.shift()) {
        if (event.name !== EVENT.leaseBuyout) continue
        transferToProvider({ name: event.name, record: record(LEASES, event.record), subject: event.parm1, position: event.parm2 }, record(LEASES, event.record))
    }
}

beforeEach(() => {
    platform.reset()
    platform.clock = Date.parse('2026-03-01T08:00:00Z')
    platform.uniqueKeys = { [LOCKS]: 'name' }
    platform.references = { [`${ASSETS}.x_daas_ham_lease`]: LEASES }
    platform.properties = { 'x_daas_ham.provider_company': 'provider-co' }
    platform.defaults = { [DISPOSALS]: () => ({ number: 'DSP0001' }) }
    platform.tables[LEASES] = [{ sys_id: 'lease1', number: 'LSE0001', vendor: 'lessor-co', ends: '2026-03-31', end_action: 'undecided', buyout_price: '100', mismatch: 'true' }]
    platform.tables[DECISIONS] = [{ sys_id: 'dec1', number: 'LDEC0001', lease: 'lease1', active: 'true', state: '1' }]
    platform.tables[ASSETS] = []
})

describe('a buy-out decision', () => {
    beforeEach(() => {
        platform.tables[ASSETS] = [
            leased('a1', 'in_service'),
            leased('a2', 'available'),
            leased('a3', 'pending_wipe'),
            leased('gone', 'returned_to_lessor'),
            leased('it', 'in_service', { x_daas_ham_fleet: '' }),
            leased('other', 'in_service', { x_daas_ham_lease: 'lease2' }),
        ]
    })

    it('closes the decision, fixes the buyout terms on the lease and queues the transfer', () => {
        expect(applyLeaseDecision(decide({ decision: 'buyout' }))).toEqual({
            applied: true,
            notes: ["The lease's assets become Provider-owned in the background"],
            problems: [],
        })

        expect(decisionRow()).toMatchObject({ state: '3', decision: 'buyout' })
        expect(lease()).toMatchObject({ end_action: 'buyout', ends: '2026-03-31', buyout_assets: '3', buyout_share: '33.33', buyout_extra_through: 'a1' })
        expect(platform.events).toEqual([{ name: EVENT.leaseBuyout, record: 'lease1', parm1: 'lease1', parm2: '', delayed: false }])
        expect(rows(ASSETS).map((row) => row.x_daas_ham_legal_owner)).toEqual(['lessor', 'lessor', 'lessor', 'lessor', 'lessor', 'lessor'])
    })

    it('makes the Provider own each covered Asset, the price split over them to the cent', () => {
        platform.properties['x_daas_ham.job.batch_size'] = '2'
        applyLeaseDecision(decide({ decision: 'buyout' }))

        runBuyout()

        const bought = { x_daas_ham_lease: '', x_daas_ham_legal_owner: 'provider', purchase_date: '2026-03-01' }
        expect(asset('a1')).toMatchObject({ ...bought, cost: '33.34' })
        expect(asset('a2')).toMatchObject({ ...bought, cost: '33.33' })
        expect(asset('a3')).toMatchObject({ ...bought, cost: '33.33' })
        const kept = { x_daas_ham_legal_owner: 'lessor', cost: '900', purchase_date: '2024-01-01' }
        expect(asset('gone')).toMatchObject({ ...kept, x_daas_ham_lease: 'lease1' })
        expect(asset('it')).toMatchObject({ ...kept, x_daas_ham_lease: 'lease1' })
        expect(asset('other')).toMatchObject({ ...kept, x_daas_ham_lease: 'lease2' })
        expect(platform.events).toEqual([])
        expect(platform.logs).toEqual([])
    })

    it('keeps each cost and purchase date when the buyout has no price', () => {
        lease().buyout_price = ''
        applyLeaseDecision(decide({ decision: 'buyout' }))

        runBuyout()

        expect(lease()).toMatchObject({ buyout_assets: '3', buyout_share: '0' })
        expect(lease().buyout_extra_through ?? '').toBe('')
        expect(asset('a1')).toMatchObject({ x_daas_ham_lease: '', x_daas_ham_legal_owner: 'provider', cost: '900', purchase_date: '2024-01-01' })
    })

    it("leaves an Asset whose save is refused the Lessor's, with a warning, and transfers the rest", () => {
        applyLeaseDecision(decide({ decision: 'buyout' }))
        platform.refuses = (table, row) => (table === ASSETS && row.sys_id === 'a2' ? 'asset is read only' : '')

        runBuyout()

        expect(asset('a2')).toMatchObject({ x_daas_ham_lease: 'lease1', x_daas_ham_legal_owner: 'lessor', cost: '900' })
        expect(asset('a1').x_daas_ham_legal_owner).toBe('provider')
        expect(asset('a3').x_daas_ham_legal_owner).toBe('provider')
        expect(platform.warnings).toEqual([expect.stringContaining('Buyout of LSE0001: FOC-a2 not transferred: asset is read only')])
    })
})

describe('an extension', () => {
    it('moves the lease end, leaves the lease undecided and clears its mismatch', () => {
        expect(applyLeaseDecision(decide({ decision: 'extend', new_end_date: '2027-03-31' }))).toEqual({ applied: true, notes: [], problems: [] })

        expect(decisionRow().state).toBe('3')
        expect(lease()).toMatchObject({ ends: '2027-03-31', end_action: 'undecided', mismatch: 'false' })
        expect(lease().buyout_assets ?? '').toBe('')
        expect(platform.events).toEqual([])
    })

    it('is not applied without a new end date after the lease end, and the decision stays open', () => {
        expect(applyLeaseDecision(decide({ decision: 'extend', new_end_date: '2026-03-31' }))).toEqual({
            applied: false,
            notes: [],
            problems: ['An extension needs a new end date after the current lease end'],
        })

        expect(decisionRow().state).toBe('1')
        expect(lease()).toMatchObject({ ends: '2026-03-31', end_action: 'undecided', mismatch: 'true' })
    })
})

describe('a return to the lessor', () => {
    beforeEach(() => {
        platform.tables[ASSETS] = [
            leased('a1', 'available'),
            leased('a2', 'spare_pool', { company: 'acme', x_daas_ham_agreement: 'ag1' }),
            leased('a3', 'spare_pool', { company: 'acme', x_daas_ham_agreement: 'ag1', x_daas_ham_order_line: 'ol1' }),
            leased('a4', 'in_service', { company: 'acme', x_daas_ham_agreement: 'ag1', x_daas_ham_site: 'site1' }),
            leased('a5', 'reserved', { company: 'acme', x_daas_ham_agreement: 'ag1', x_daas_ham_order_line: 'ol2' }),
        ]
    })

    const returned = () => applyLeaseDecision(decide({ decision: 'return' }))

    it('withdraws the free stock to pending wipe onto a draft disposal, and queues the refresh of the rest', () => {
        expect(returned()).toEqual({ applied: true, notes: ["The lease's stock awaits wipe on draft disposal order DSP0001"], problems: [] })

        expect(decisionRow().state).toBe('3')
        expect(lease().end_action).toBe('return')
        expect(asset('a1')).toMatchObject(stage('pending_wipe'))
        // A Spare pool unit goes through available, where it is the Provider's own stock again.
        expect(asset('a2')).toMatchObject({ ...stage('pending_wipe'), company: 'provider-co', x_daas_ham_agreement: '' })
        expect(rows(DISPOSALS)).toEqual([expect.objectContaining({ number: 'DSP0001', method: 'return_to_lessor', disposal_vendor: 'lessor-co' })])
        expect(rows(DISPOSALS)[0]?.short_description).toBe('Return stock to the lessor at the end of lease LSE0001')
        expect(rows(DISPOSAL_LINES).map((line) => [line.disposal_order, line.asset])).toEqual([
            [rows(DISPOSALS)[0]?.sys_id, 'a1'],
            [rows(DISPOSALS)[0]?.sys_id, 'a2'],
        ])
        expect(platform.events).toEqual([{ name: EVENT.leaseAssets, record: 'lease1', parm1: 'lease1', parm2: '', delayed: false }])
        expect(rows(LOCKS)).toEqual([])
        expect(platform.logs).toEqual([])
    })

    it('leaves a hot spare on an Order line, a reserved unit and an installed unit where they are', () => {
        returned()

        expect(asset('a3')).toMatchObject({ ...stage('spare_pool'), x_daas_ham_order_line: 'ol1', company: 'acme' })
        expect(asset('a4')).toMatchObject(stage('in_service'))
        expect(asset('a5')).toMatchObject({ ...stage('reserved'), x_daas_ham_order_line: 'ol2' })
    })

    it('counts a unit whose move is refused, and lists the rest', () => {
        platform.refuses = (table, row) => (table === ASSETS && row.sys_id === 'a1' ? 'stage rule said no' : '')

        expect(returned()).toEqual({
            applied: true,
            notes: ["The lease's stock awaits wipe on draft disposal order DSP0001"],
            problems: ['1 stock unit(s) of the lease could not go to pending wipe, so are not on the disposal; see the system log'],
        })

        expect(asset('a1')).toMatchObject(stage('available'))
        expect(rows(DISPOSAL_LINES).map((line) => line.asset)).toEqual(['a2'])
        expect(platform.warnings).toEqual([expect.stringContaining('Lease return: FOC-a1 not moved to pending_wipe: stage rule said no')])
    })

    it('counts a unit whose stock lock a claim holds through every try as not withdrawn', () => {
        platform.tables[LOCKS] = [{ sys_id: 'lock1', name: LOCK.reserveAsset('a1'), sys_created_on: '2026-03-01 08:00:00' }]

        expect(returned().problems).toEqual(['1 stock unit(s) of the lease could not go to pending wipe, so are not on the disposal; see the system log'])

        expect(asset('a1')).toMatchObject(stage('available'))
        expect(platform.warnings).toEqual([expect.stringContaining('Lease return: FOC-a1 not withdrawn: its stock lock could not be taken')])
    })

    it('leaves a unit a claim took since the query to that claim, uncounted', () => {
        // Sourcing reserves a1 as the return takes its stock lock.
        platform.onSave = (table, row, operation) => {
            if (table === LOCKS && operation === 'insert' && row.name === LOCK.reserveAsset('a1')) Object.assign(asset('a1'), stage('reserved'), { x_daas_ham_order_line: 'ol9' })
        }

        expect(returned()).toEqual({ applied: true, notes: ["The lease's stock awaits wipe on draft disposal order DSP0001"], problems: [] })

        expect(asset('a1')).toMatchObject({ ...stage('reserved'), x_daas_ham_order_line: 'ol9' })
        expect(rows(DISPOSAL_LINES).map((line) => line.asset)).toEqual(['a2'])
    })

    it('counts a unit at pending wipe whose disposal line is refused as unlisted', () => {
        platform.refuses = (table, row) => (table === DISPOSAL_LINES && row.asset === 'a2' ? 'line refused' : '')

        expect(returned()).toEqual({
            applied: true,
            notes: ["The lease's stock awaits wipe on draft disposal order DSP0001"],
            problems: ['1 stock unit(s) of the lease went to pending wipe but are on no disposal order; see the system log and add them to one by hand'],
        })

        expect(asset('a2')).toMatchObject(stage('pending_wipe'))
        expect(rows(DISPOSAL_LINES).map((line) => line.asset)).toEqual(['a1'])
        expect(platform.warnings).toEqual([expect.stringContaining('Lease return: FOC-a2 left off DSP0001: line refused')])
    })

    it('counts every withdrawn unit as unlisted when the disposal order itself is refused, asking for it once', () => {
        platform.refuses = (table) => (table === DISPOSALS ? 'no disposal today' : '')

        expect(returned()).toEqual({
            applied: true,
            notes: [],
            problems: ['2 stock unit(s) of the lease went to pending wipe but are on no disposal order; see the system log and add them to one by hand'],
        })

        expect(rows(DISPOSALS)).toEqual([])
        expect(rows(DISPOSAL_LINES)).toEqual([])
        expect(platform.warnings).toEqual([expect.stringContaining('Lease return: no disposal order for LSE0001: no disposal today')])
    })

    it('raises no disposal for a lease with no free stock', () => {
        platform.tables[ASSETS] = [leased('a4', 'in_service')]

        expect(returned()).toEqual({ applied: true, notes: [], problems: [] })

        expect(rows(DISPOSALS)).toEqual([])
        expect(platform.events.map((event) => event.name)).toEqual([EVENT.leaseAssets])
    })
})

describe('a decision that is not applied', () => {
    function leaseUntouched(): void {
        expect(lease()).toMatchObject({ end_action: 'undecided', ends: '2026-03-31' })
        expect(platform.events).toEqual([])
    }

    it('is one already closed', () => {
        decisionRow().active = 'false'

        expect(applyLeaseDecision(decide({ decision: 'buyout' }))).toEqual({ applied: false, notes: [], problems: ['This decision is closed'] })
        leaseUntouched()
    })

    it('is one whose lease schedule is gone', () => {
        platform.tables[LEASES] = []

        expect(applyLeaseDecision(decide({ decision: 'buyout' }))).toEqual({ applied: false, notes: [], problems: ['The lease schedule no longer exists'] })
    })

    it('is one with nothing chosen', () => {
        expect(applyLeaseDecision(decide({}))).toEqual({ applied: false, notes: [], problems: ['Choose buy out, extend or return'] })
        expect(decisionRow().state).toBe('1')
        leaseUntouched()
    })

    it.each([
        ['buyout', 'The lease is already being bought out'],
        ['return', 'The lease is already being returned to the lessor'],
    ])('is any decision on a lease whose end action is already %s', (endAction, problem) => {
        lease().end_action = endAction

        expect(applyLeaseDecision(decide({ decision: 'extend', new_end_date: '2027-03-31' }))).toEqual({ applied: false, notes: [], problems: [problem] })
        expect(decisionRow().state).toBe('1')
        expect(lease().ends).toBe('2026-03-31')
    })

    it('is one the platform refuses to close: nothing is told, and the lease is left alone', () => {
        platform.refuses = (table) => (table === DECISIONS ? 'mandatory field' : '')

        expect(applyLeaseDecision(decide({ decision: 'buyout' }))).toEqual({ applied: false, notes: [], problems: [] })
        expect(decisionRow().state).toBe('1')
        leaseUntouched()
    })
})

describe('a lease the platform refuses to save', () => {
    beforeEach(() => {
        platform.tables[ASSETS] = [leased('a1', 'available')]
    })

    function nothingStarted(): void {
        expect(lease().end_action).toBe('undecided')
        expect(asset('a1')).toMatchObject(stage('available'))
        expect(rows(DISPOSALS)).toEqual([])
        expect(platform.events).toEqual([])
    }

    it('opens the decision again and starts neither the transfer nor the return', () => {
        platform.refuses = (table) => (table === LEASES ? 'lease is locked' : '')

        expect(applyLeaseDecision(decide({ decision: 'return' }))).toEqual({
            applied: false,
            notes: [],
            problems: ['Lease LSE0001 not saved: lease is locked. The decision is open again'],
        })

        expect(decisionRow().state).toBe('1')
        nothingStarted()
    })

    it('says so when the decision cannot be opened again either, and logs it', () => {
        platform.refuses = (table, row) => (table === LEASES || (table === DECISIONS && row.state === '1') ? 'locked' : '')

        expect(applyLeaseDecision(decide({ decision: 'buyout' }))).toEqual({
            applied: false,
            notes: [],
            problems: ['Lease LSE0001 not saved: locked. The decision stays closed (see the system log); the daily lease review raises a new one'],
        })

        expect(decisionRow().state).toBe('3')
        expect(platform.warnings).toEqual([expect.stringContaining('Lease decision LDEC0001 not reopened (Lease LSE0001 not saved: locked): locked')])
        nothingStarted()
    })
})
```

**Verify**: `npx vitest run src/server/platform/lease-decisions.test.ts` → `Tests  22 passed (22)`.

### Step 3: Create the disposal tests

Create `src/server/platform/disposal.test.ts` with exactly this content:

```ts
import { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fieldsOf, type Stage } from '../domain/lifecycle.ts'
import { completeDisposal, submitDisposal } from './disposal.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const ASSETS = 'alm_hardware'
const ORDERS = 'x_daas_ham_disposal_order'
const LINES = 'x_daas_ham_disposal_line'
const APPROVALS = 'sysapproval_approver'

const rows = (table: string): Row[] => platform.tables[table] ?? []
const asset = (id: string): Row => rows(ASSETS).find((row) => row.sys_id === id) ?? {}
const line = (id: string): Row => rows(LINES).find((row) => row.sys_id === id) ?? {}
const order = (): Row => rows(ORDERS)[0] ?? {}

function stage(of: Stage): Row {
    const { installStatus, substatus } = fieldsOf(of)
    return { install_status: installStatus, substatus: substatus ?? '' }
}

/** A wiped fleet asset awaiting wipe sign-off, the Provider's own unless `fields` say otherwise. */
function wiped(id: string, fields: Row = {}): Row {
    return {
        sys_id: id,
        serial_number: `FOC-${id}`,
        x_daas_ham_fleet: 'true',
        x_daas_ham_legal_owner: 'provider',
        company: 'provider-co',
        x_daas_ham_wiped_on: '2026-02-20',
        x_daas_ham_wipe_certificate: 'CERT-1',
        ...stage('pending_wipe'),
        ...fields,
    }
}

function lineFor(assetId: string, fields: Row = {}): Row {
    return { sys_id: `line-${assetId}`, disposal_order: 'dsp1', asset: assetId, status: 'pending', ...fields }
}

/** The order as its form sends it: read from the table, with `changed` set on the record and not saved yet. */
function orderRecord(changed: Row = {}): GlideRecord {
    const record = new GlideRecord(ORDERS)
    record.get('dsp1')
    for (const [field, value] of Object.entries(changed)) record.setValue(field, value)
    return record
}

function user(id: string, role: string, company = 'provider-co'): void {
    ;(platform.tables.sys_user ??= []).push({ sys_id: id, company, active: 'true' })
    ;(platform.tables.sys_user_has_role ??= []).push({ sys_id: `role-of-${id}`, role, user: id, state: 'active' })
}

const requests = (): Record<string, string> => Object.fromEntries(rows(APPROVALS).map((row) => [row.approver, row.state]))

beforeEach(() => {
    platform.reset()
    platform.references = {
        [`${LINES}.asset`]: ASSETS,
        'sys_user_has_role.role': 'sys_user_role',
        'sys_user_has_role.user': 'sys_user',
    }
    platform.tables.sys_user_role = [
        { sys_id: 'am_role', name: 'x_daas_ham.asset_manager' },
        { sys_id: 'ca_role', name: 'x_daas_ham.customer_admin' },
    ]
    user('am', 'am_role')
    user('ca', 'ca_role', 'acme')
    user('ca-other', 'ca_role', 'globex')
    platform.tables[ORDERS] = [{ sys_id: 'dsp1', number: 'DSP0001', stage: 'draft', method: 'itad_recycle', customer: '' }]
    platform.tables[ASSETS] = [wiped('a1')]
    platform.tables[LINES] = [lineFor('a1')]
})

describe('submitting a draft Disposal order', () => {
    it("asks the asset managers alone for the Provider's own assets", () => {
        expect(submitDisposal(orderRecord())).toEqual({ submitted: true })

        expect(requests()).toEqual({ am: 'requested' })
        expect(rows(APPROVALS)[0]).toMatchObject({ sysapproval: 'dsp1', source_table: ORDERS, document_id: 'dsp1' })
        expect(order()).toMatchObject({ stage: 'awaiting_approval', approval: 'requested' })
        expect(order().approval_customer_admins ?? '').toBe('')
    })

    it("asks the admins of the order's Customer too when a customer-owned asset is on it", () => {
        order().customer = 'acme'
        platform.tables[ASSETS] = [wiped('a1'), wiped('a2', { x_daas_ham_legal_owner: 'customer', company: 'acme' })]
        platform.tables[LINES] = [lineFor('a1'), lineFor('a2')]

        expect(submitDisposal(orderRecord())).toEqual({ submitted: true })

        expect(requests()).toEqual({ am: 'requested', ca: 'requested' })
        expect(order()).toMatchObject({ stage: 'awaiting_approval', approval_customer_admins: 'ca' })
    })

    it('lets the asset managers stand in for a Customer with no admin', () => {
        order().customer = 'initech'
        platform.tables[ASSETS] = [wiped('a1', { x_daas_ham_legal_owner: 'customer', company: 'initech' })]

        expect(submitDisposal(orderRecord())).toEqual({ submitted: true })

        expect(requests()).toEqual({ am: 'requested' })
        expect(order().approval_customer_admins ?? '').toBe('')
    })

    it.each([
        ['an order with no lines', () => (platform.tables[LINES] = []), 'Add the assets to dispose of first'],
        [
            'a customer-owned asset on an order that names no Customer',
            () => Object.assign(asset('a1'), { x_daas_ham_legal_owner: 'customer', company: 'acme' }),
            'Set the customer whose assets are being returned',
        ],
        [
            "a customer-owned asset of another Customer than the order's",
            () => {
                order().customer = 'globex'
                Object.assign(asset('a1'), { x_daas_ham_legal_owner: 'customer', company: 'acme' })
            },
            "Not the order's customer's assets: FOC-a1",
        ],
        ['an order with no asset manager to ask', () => (platform.tables.sys_user_has_role = []), 'Not submitted: no asset manager to approve it'],
    ])('keeps %s a draft and asks nobody', (_what, arrange, why) => {
        arrange()

        expect(submitDisposal(orderRecord())).toEqual({ submitted: false, why })

        expect(rows(APPROVALS)).toEqual([])
        expect(order().stage).toBe('draft')
    })

    it('asks nobody, and tells nothing more, when the platform refuses to save the form', () => {
        platform.refuses = (table) => (table === ORDERS ? 'mandatory field' : '')

        expect(submitDisposal(orderRecord({ short_description: 'Recycle the old switches' }))).toEqual({ submitted: false, why: '' })

        expect(rows(APPROVALS)).toEqual([])
        expect(order().stage).toBe('draft')
    })

    it('cancels its requests when the platform refuses to save it as awaiting approval', () => {
        platform.refuses = (table, row) => (table === ORDERS && row.stage === 'awaiting_approval' ? 'stage rule said no' : '')

        expect(submitDisposal(orderRecord())).toEqual({ submitted: false, why: '' })

        expect(requests()).toEqual({ am: 'cancelled' })
        expect(order().stage).toBe('draft')
        expect(platform.warnings).toEqual([expect.stringContaining('DSP0001 not saved as awaiting approval, its requests cancelled: stage rule said no')])
    })
})

describe('completing an approved Disposal order', () => {
    beforeEach(() => {
        Object.assign(order(), { stage: 'approved', approval: 'approved', state: '1' })
    })

    it('retires each ready asset by the order method and completes the order', () => {
        expect(completeDisposal(orderRecord())).toEqual({ completed: true, blocked: 0, unsaved: 0 })

        expect(asset('a1')).toMatchObject(stage('disposed'))
        expect(line('line-a1')).toMatchObject({ status: 'done' })
        expect(line('line-a1').blockers ?? '').toBe('')
        expect(order()).toMatchObject({ stage: 'completed', state: '3' })
        expect(platform.logs).toEqual([])
    })

    it.each([
        ['broker_resale', 'provider', 'sold'],
        ['oem_takeback', 'provider', 'returned_to_oem'],
        ['return_to_lessor', 'lessor', 'returned_to_lessor'],
    ] as const)("retires a line by its own method %s, whatever the order's", (method, owner, retired) => {
        Object.assign(asset('a1'), { x_daas_ham_legal_owner: owner })
        line('line-a1').method = method

        expect(completeDisposal(orderRecord())).toMatchObject({ completed: true })

        expect(asset('a1')).toMatchObject(stage(retired))
    })

    it("returns a customer-owned asset to the order's Customer", () => {
        Object.assign(order(), { customer: 'acme', method: 'return_to_customer' })
        Object.assign(asset('a1'), { x_daas_ham_legal_owner: 'customer', company: 'acme' })

        expect(completeDisposal(orderRecord())).toMatchObject({ completed: true })

        expect(asset('a1')).toMatchObject(stage('returned_to_customer'))
    })

    it.each([
        ['no wipe evidence', () => (asset('a1').x_daas_ham_wipe_certificate = ''), 'no wipe evidence'],
        ['a stage that awaits neither wipe nor disposal', () => Object.assign(asset('a1'), stage('available')), 'asset is available, not awaiting wipe or disposal'],
        ["one of the Provider IT's assets", () => (asset('a1').x_daas_ham_fleet = ''), 'asset is not a fleet asset'],
        ["a method its owner's assets do not leave by", () => (asset('a1').x_daas_ham_legal_owner = 'lessor'), 'a lessor-owned asset can only be return to lessor'],
        [
            "a customer-owned asset of another Customer than the order's",
            () => {
                Object.assign(order(), { customer: 'globex', method: 'return_to_customer' })
                Object.assign(asset('a1'), { x_daas_ham_legal_owner: 'customer', company: 'acme' })
            },
            "asset does not belong to the order's customer",
        ],
        ['an asset the user cannot read', () => (platform.tables[ASSETS] = []), 'asset not found, or not in your stockrooms'],
    ])('blocks a line for %s, and keeps the order open', (_what, arrange, blocker) => {
        arrange()
        const before = { ...asset('a1') }

        expect(completeDisposal(orderRecord())).toEqual({ completed: false, blocked: 1, unsaved: 0 })

        expect(line('line-a1')).toMatchObject({ status: 'blocked', blockers: blocker })
        expect(asset('a1')).toEqual(before)
        expect(order()).toMatchObject({ stage: 'approved', state: '1' })
    })

    it('names every blocker of a line, joined', () => {
        Object.assign(asset('a1'), stage('available'), { x_daas_ham_wiped_on: '' })

        completeDisposal(orderRecord())

        expect(line('line-a1').blockers).toBe('asset is available, not awaiting wipe or disposal; no wipe evidence')
    })

    it('blocks a line with why the platform refused to retire its asset', () => {
        platform.refuses = (table, row) => (table === ASSETS && row.install_status === fieldsOf('disposed').installStatus ? 'retirement needs sign-off' : '')

        expect(completeDisposal(orderRecord())).toEqual({ completed: false, blocked: 1, unsaved: 0 })

        expect(line('line-a1')).toMatchObject({ status: 'blocked', blockers: 'retirement needs sign-off' })
        // The move before the refused one stays saved.
        expect(asset('a1')).toMatchObject(stage('pending_disposal'))
    })

    describe('with a ready line and a blocked one', () => {
        beforeEach(() => {
            platform.tables[ASSETS] = [wiped('a1'), wiped('a2', { x_daas_ham_wiped_on: '', x_daas_ham_wipe_certificate: '' })]
            platform.tables[LINES] = [lineFor('a1'), lineFor('a2')]
        })

        it('retires the ready one, records what blocks the other and keeps the order open', () => {
            expect(completeDisposal(orderRecord())).toEqual({ completed: false, blocked: 1, unsaved: 0 })

            expect(asset('a1')).toMatchObject(stage('disposed'))
            expect(line('line-a1').status).toBe('done')
            expect(asset('a2')).toMatchObject(stage('pending_wipe'))
            expect(line('line-a2')).toMatchObject({ status: 'blocked', blockers: 'no wipe evidence' })
            expect(order()).toMatchObject({ stage: 'approved', state: '1' })
        })

        it('completes once the blocker is cleared, without touching the line already done', () => {
            completeDisposal(orderRecord())
            Object.assign(asset('a2'), { x_daas_ham_wiped_on: '2026-02-21', x_daas_ham_wipe_certificate: 'CERT-2' })
            const done = { ...line('line-a1') }
            const retired = { ...asset('a1') }
            platform.clock += 60_000

            expect(completeDisposal(orderRecord())).toEqual({ completed: true, blocked: 0, unsaved: 0 })

            expect(line('line-a1')).toEqual(done)
            expect(asset('a1')).toEqual(retired)
            expect(asset('a2')).toMatchObject(stage('disposed'))
            expect(line('line-a2')).toMatchObject({ status: 'done', blockers: '' })
            expect(order()).toMatchObject({ stage: 'completed', state: '3' })
        })
    })

    it('counts a line the platform refuses to save, logs it and keeps the order open, its asset retired', () => {
        platform.refuses = (table) => (table === LINES ? 'line is read only' : '')

        expect(completeDisposal(orderRecord())).toEqual({ completed: false, blocked: 0, unsaved: 1 })

        expect(asset('a1')).toMatchObject(stage('disposed'))
        expect(line('line-a1').status).toBe('pending')
        expect(order().stage).toBe('approved')
        expect(platform.warnings).toEqual([expect.stringContaining('DSP0001 line for a1 not saved (done, its asset retired): line is read only')])
    })

    it('reports an order the platform refuses to save as completed, and closes it when completed again', () => {
        platform.refuses = (table, row) => (table === ORDERS && row.stage === 'completed' ? 'closure needs a note' : '')

        expect(completeDisposal(orderRecord())).toEqual({ completed: false, blocked: 0, unsaved: 0, refused: 'closure needs a note' })

        expect(asset('a1')).toMatchObject(stage('disposed'))
        expect(line('line-a1').status).toBe('done')
        expect(order()).toMatchObject({ stage: 'approved', state: '1' })

        platform.refuses = () => ''
        const retired = { ...asset('a1') }
        platform.clock += 60_000

        expect(completeDisposal(orderRecord())).toEqual({ completed: true, blocked: 0, unsaved: 0 })

        expect(asset('a1')).toEqual(retired)
        expect(order()).toMatchObject({ stage: 'completed', state: '3' })
    })

    it('retires nothing when the platform refuses to save the form it was asked from', () => {
        platform.refuses = (table) => (table === ORDERS ? 'method changed after submit' : '')

        expect(completeDisposal(orderRecord({ method: 'broker_resale' }))).toEqual({ completed: false, blocked: 0, unsaved: 0 })

        expect(asset('a1')).toMatchObject(stage('pending_wipe'))
        expect(line('line-a1').status).toBe('pending')
    })
})
```

**Verify**: `npx vitest run src/server/platform/disposal.test.ts` → `Tests  27 passed (27)`.

### Step 4: Run the gate and commit

**Verify**:

- `npm run typecheck` → exit 0.
- `npm run lint` → exit 0.
- `npm run check` → exit 0, and the test total is 49 higher than before this plan (1635 if nothing else landed since `1864b17`, where it was 1586).
- `git status --short` → only the two new test files (and `plans/README.md` once you update it).

Then commit the two files.

## Test plan

Every test is in the two blocks above. The tables say what each one sets up beyond its file's shared
fixture and what it asserts, so that a failure can be reported by behaviour.

`lease-decisions.test.ts`. Shared fixture: the clock at 2026-03-01, an undecided lease `LSE0001` of vendor
`lessor-co` ending 2026-03-31 with a buy-out price of 100 and its mismatch flag set, one open
decision `LDEC0001` (state 1), and the Provider's company `provider-co`. `decide({...})` returns the
decision record with the chosen values set and not saved, as its form sends it.

| Test | Setup | Asserts |
|---|---|---|
| buy-out is applied | six Assets: `a1` in service, `a2` available, `a3` pending wipe, one retired, one outside the fleet, one on another lease | applied, with the note about the background transfer. Decision state 3. Lease end action buyout, 3 Assets, share 33.33, extra cent through `a1`. One `x_daas_ham.lease.buyout` event on the lease. No Asset changed yet |
| buy-out transfer | the same, batch size 2, then the queued event is run | `a1` costs 33.34, `a2` and `a3` 33.33, each Provider-owned, off the lease, bought 2026-03-01. The other three keep owner, cost, purchase date and lease. No event left, nothing logged |
| buy-out without a price | price blank | lease has 3 Assets and share 0. `a1` Provider-owned and off the lease, cost and purchase date kept |
| buy-out, one save refused | update of `a2` refused during the transfer | `a2` stays the Lessor's on the lease, `a1` and `a3` transferred, one warning naming `FOC-a2` |
| extension | new end date 2027-03-31 | applied, no notes. Decision state 3. Lease ends 2027-03-31, undecided, mismatch false, no buy-out terms. No event |
| extension without a later date | new end date equals the lease end | not applied, with the problem text. Decision state 1, lease unchanged |
| return withdraws stock | `a1` available, `a2` Spare pool, `a3` Spare pool on an Order line, `a4` in service, `a5` reserved | applied, note naming `DSP0001`. Decision state 3, end action return. `a1` and `a2` at pending wipe, `a2` back with the Provider's company and no Agreement. One draft disposal (method return_to_lessor, vendor `lessor-co`) with lines for `a1` and `a2`. One `x_daas_ham.lease.assets` event. No lock row, nothing logged |
| return leaves the rest | the same | `a3` still Spare pool on its line, `a4` in service, `a5` reserved on its line |
| return, a move refused | update of `a1` refused | applied, the note, one problem "1 stock unit(s) ... could not go to pending wipe". `a1` available, line for `a2` only, one warning |
| return, stock lock held | lock row `LOCK.reserveAsset('a1')` | the same problem text, `a1` available, warning "its stock lock could not be taken" |
| return, unit claimed meanwhile | `a1` set reserved on a line as its stock lock is taken | applied, no problem. `a1` reserved on that line, line for `a2` only |
| return, line refused | insert of the line for `a2` refused | applied, the note, one problem "1 stock unit(s) ... on no disposal order". `a2` at pending wipe, line for `a1` only, one warning |
| return, disposal refused | insert of the disposal order refused | applied, no note, problem "2 stock unit(s) ... on no disposal order". No disposal, no line, exactly one warning |
| return without stock | only an in-service Asset | applied, no notes, no problems, no disposal, one `x_daas_ham.lease.assets` event |
| closed decision | decision not active | not applied, "This decision is closed", lease unchanged, no event |
| lease gone | no lease row | not applied, "The lease schedule no longer exists" |
| nothing chosen | no decision value | not applied, "Choose buy out, extend or return", decision state 1 |
| lease already decided (two cases) | lease end action buyout, then return | not applied, with that end action's text. Decision state 1, lease end unchanged |
| decision cannot be closed | decision update refused | not applied, no notes and no problems. Decision state 1, lease unchanged |
| lease save refused | lease update refused, decision return, `a1` available | not applied, "Lease LSE0001 not saved: lease is locked. The decision is open again". Decision state 1. `a1` available, no disposal, no event |
| lease save refused, reopen refused | lease update refused, and the decision update back to state 1 refused | not applied, "... The decision stays closed (see the system log); the daily lease review raises a new one". Decision state 3, one warning naming `LDEC0001`. `a1` available, no disposal, no event |

`disposal.test.ts`. Shared fixture: asset manager `am`, Customer admins `ca` (of `acme`) and
`ca-other` (of `globex`), a draft order `DSP0001` with method `itad_recycle` and no Customer, and one
line for `a1`, a Provider-owned fleet Asset at pending wipe with wipe evidence. `orderRecord({...})`
returns the order record with the given values set and not saved, as its form sends it.

| Test | Setup | Asserts |
|---|---|---|
| submit, Provider's own assets | none | submitted. One request, to `am`, on the order. Stage awaiting_approval, approval requested, no Customer admins recorded |
| submit, customer-owned asset | order Customer `acme`, second Asset owned by `acme` | submitted. Requests to `am` and `ca` (not `ca-other`). `approval_customer_admins` is `ca` |
| submit, Customer without admins | order Customer `initech`, `a1` owned by `initech` | submitted. One request, to `am`. No Customer admins recorded |
| submit refused (four cases) | no lines. Customer-owned Asset and no order Customer. Customer-owned Asset of another Customer. No asset manager | not submitted, each with its own reason. No request, stage draft |
| submit, form save refused | a field changed on the record, order update refused | not submitted with an empty reason. No request, stage draft |
| submit, awaiting-approval save refused | order update to awaiting_approval refused | not submitted with an empty reason. The request to `am` is cancelled, stage draft, one warning |
| complete | order approved | completed. `a1` disposed, line done with no blockers, order stage completed and state 3, nothing logged |
| complete by line method (three cases) | line method broker_resale, oem_takeback, or return_to_lessor on a Lessor-owned Asset | completed. `a1` sold, returned to OEM, or returned to Lessor |
| complete, return to Customer | order Customer `acme`, method return_to_customer, `a1` owned by `acme` | completed. `a1` returned to Customer |
| complete blocked (six cases) | no wipe certificate. Stage available. Outside the fleet. Lessor-owned on a Provider method. Customer-owned of another Customer. Asset row missing | not completed, 1 blocked, 0 unsaved. Line blocked with that blocker text. Asset row unchanged. Order approved, state 1 |
| every blocker named | stage available and no wipe date | line blockers joined with "; " |
| complete, retiring save refused | Asset update to its retired install status refused | not completed, 1 blocked. Line blocked with the refusal. `a1` left at pending disposal |
| one ready, one blocked | `a2` without wipe evidence, two lines | not completed, 1 blocked. `a1` disposed and its line done. `a2` at pending wipe, its line blocked "no wipe evidence". Order approved |
| complete again after the fix | the same, completed once, then `a2` given wipe evidence, clock one minute on | completed. Line and Asset `a1` rows identical to before the second run. `a2` disposed, its line done, order completed |
| complete, line save refused | line update refused | not completed, 0 blocked, 1 unsaved. `a1` disposed, line still pending, order approved, one warning |
| complete, order save refused, then again | order update to completed refused | not completed with `refused` set. `a1` disposed, line done, order approved. Refusal lifted and completed again: completed, `a1` row identical, order completed |
| complete, form save refused | a field changed on the record, order update refused | not completed, 0 blocked, 0 unsaved. `a1` at pending wipe, line pending |

Structural pattern: `src/server/platform/returns.test.ts` and `src/server/platform/approvals.test.ts`.

## Done criteria

All local. No instance is needed. ALL must hold:

- [ ] `npx vitest run src/server/platform/lease-decisions.test.ts` → 22 passed
- [ ] `npx vitest run src/server/platform/disposal.test.ts` → 27 passed
- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm run check` exits 0
- [ ] `git show --stat --format= HEAD` lists the two test files and no other file (`plans/README.md` aside)
- [ ] `git status --short` shows no file outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- **A new test fails.** First compare your file with the block in this plan and copy it again if it differs. If it still fails, stop. Report the test's full name, and the expected and received values that vitest prints. Do not change the code under test, do not edit the assertion, do not skip the test, and do not commit. The tests passed at `1864b17`, so a failure means the behaviour changed since, and the owner must decide which is right.
- A test throws an error that starts with `fake Glide:`. The fake does not model something the code now does. Changing `test-support/` is out of scope.
- The drift check shows a change in a file under test, other than plan 008's run lock in `runLeaseReview`, and the excerpts in "Current state" no longer match.
- `npm run typecheck` or `npm run lint` reports an error in one of the two new files after you copied it again from this plan.
- `npm run check` changes `src/fluent/generated/keys.ts`. This plan adds no metadata, so that change comes from somewhere else.
- A test file with either name already exists.

## Maintenance notes

- These are characterization tests. When lease or disposal behaviour changes on purpose, change the matching test in the same commit and say so in the commit body.
- The tests assert the exact notes and problems that `applyLeaseDecision` returns, because the form shows them to the user. They assert only a fragment of each log line.
- Not covered, and why:
  - `runLeaseReview`. Plan 008 adds a run lock there, with tests.
  - `giveToLessor`. The ATF test `leasedAssetOwnershipTest` covers the rule on an instance.
  - `lineChangeRefusal` and `orderChangeRefusal` in `disposal.ts`. They read `current.operation()`, which the fake does not have.
  - `rollUpDisposalApprovals`. `src/server/platform/approvals.test.ts` covers the roll-up it calls.
  - A stock lock lost while a unit is being withdrawn (`moveOutOfStock`), and real concurrency. The fake runs one transaction at a time.
- Two guards in `leases.ts` are doubled, so removing one of each pair changes nothing a test can see. `disposeStockToLessor` filters on `x_daas_ham_order_lineISEMPTY` and `withdrawFromStock` checks `isFree` again on the fresh read. `transferToProvider` queries `stillCovered` and its handler checks `isRetired` again. That is by design (the second check is the one made under the lock or on the fresh read). Do not delete either as dead code on the strength of these tests.
- At planning time each of these changes to the code made at least one of these tests fail: not reopening the decision, applying a closed decision, withdrawing a unit a claim took, keeping the lease link on a bought-out Asset, dropping the extra cent, not queuing the buy-out, retiring a done line again, ignoring a line's blockers, never asking the Customer admins, ignoring the Customer findings, completing an order with a blocked line, and ignoring a line's own method. A reviewer can repeat any of them.
- A reviewer should check that the commit holds the two test files and nothing else.
