# Plan 008: Hold a run lock in the lease review, attestation and overdue-return jobs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1864b17..HEAD -- src/server/domain/lock-names.ts src/server/domain/lock-names.test.ts src/server/platform/leases.ts src/server/platform/attestations.ts src/server/platform/returns.ts src/server/platform/returns.test.ts src/server/platform/locks.ts docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md docs/verify-on-instance.md`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition. (Plan 005 edits another function of
> `returns.ts`. That alone is not a mismatch if the `chaseOverdue` excerpt still matches.)

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-lint-tracked-sources.md (so `npm run lint` is a usable gate)
- **Category**: bug
- **Planned at**: commit `1864b17`, 2026-11-12

## Why this matters

Three daily jobs check for something and then create it, with nothing that stops two runs doing
both at once. A scheduled run and an admin's *Execute now* on the same job can overlap. Then:

- the lease review raises two end-of-lease decisions for one lease. Applying one closes only that
  one. The other stays open, can be applied again, and keeps the review from raising the next one;
- the attestation job opens two attestations for one Site, and the Customer admin is asked twice;
- the overdue-return job notifies the Customer and the account manager twice about one Return
  order, and both runs advance the job's one stored cursor.

The app already solves this for three other jobs (refresh Orders, OEM claims, OEM coverage): the run
holds a job lock for its whole length, and a run that finds the lock held does nothing and logs so.
This plan gives the three jobs the same lock, with the same wording, tests and documentation.

## Current state

### How job locks work here (ADR 0013)

A job lock is a row in `x_daas_ham_job_lock` behind a unique index on `name`. Taking a lock is one
insert. Releasing it deletes the row. `withLock(name, work)` in `src/server/platform/locks.ts:37`
runs `work` holding the lock and returns `{ ran: true, value }`, or `{ ran: false }` at once when
another holder has it. `work` receives a `HeldLock` (`src/server/domain/job-lock.ts:44`), whose
`held()` says whether the lock is still held. A lock held for more than 10 minutes
(`ABANDONED_AFTER_MINUTES`) is taken as abandoned and cleared by the next taker, so a long run can
lose its lock while it still runs. That is why the existing runs check `lock.held()` before they
write more.

Every lock name is declared once, in `LOCK` in `src/server/domain/lock-names.ts`. The order of the
declarations is the lock order. ADR 0013 states the rule:

```md
<!-- docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md:78-81 (line 81 goes on) -->
Locks are not re-entrant: a holder that takes a lock it already holds is refused, as any other taker
would be. A take never waits either: it tries and gives up. So locks are taken in one order, and a
holder only takes locks later in it than those it holds. The order is the order `LOCK` declares the
locks in (`src/server/domain/lock-names.ts`), and nowhere else.
```

The existing run locks, and where the new ones go (right after `oemCoverageRun`, before `seenAsset`):

```ts
// src/server/domain/lock-names.ts:26-31
    /** Held by an OEM claim run throughout, so two runs never send a step to its vendor twice. */
    oemClaimRun: () => named('oem_claim_run'),
    /** Held by an OEM coverage run throughout, so two runs never insert the same serial's contract twice. */
    oemCoverageRun: () => named('oem_coverage_run'),
    /** An Asset's sightings (the device-events REST handler, the in-service detection job) take turns under it. */
    seenAsset: (assetId: string) => named(`seen_asset_${assetId}`),
```

Why that position is right. Each of the three jobs is a scheduled script and holds no lock when it
starts, so its run lock may sit anywhere after nothing. What matters is what a run takes while it
holds its lock. The lease review and the attestation job take no other lock. The overdue-return job
declares units missing under `receive_asset_<Asset sys_id>` (`returns.ts:498`), and under that the
fee, service-interval and reconciliation-exception locks. All of those are declared after
`seenAsset`, so a run lock declared before `seenAsset` comes before every lock taken under it. None
of the three jobs submits an Order, so none takes `refresh_orders` or `agreement_usage_`, the locks
declared before this position.

The test that holds each name:

```ts
// src/server/domain/lock-names.test.ts:34-36
        expect(LOCK.oemClaimRun()).toBe('oem_claim_run')
        expect(LOCK.oemCoverageRun()).toBe('oem_coverage_run')
        expect(LOCK.seenAsset(a)).toBe(`seen_asset_${a}`)
```

### The precedent to copy

```ts
// src/server/platform/refresh.ts:40-44
export function raiseRefreshOrders(): void {
    const lockName = LOCK.refreshOrders()
    if (withLock(lockName, raiseDueHolding).ran) return
    log.info(`Refresh Orders not raised: another run holds the ${lockName} lock and raises them`)
}
```

```ts
// src/server/platform/refresh.ts:51-59
function raiseDueHolding(lock: HeldLock): void {
    for (const wave of refreshWaves(dueCandidates())) {
        const number = raiseWave(wave)
        if (lock.held()) continue
        const check = number ? `; check ${number}'s Assets are on no other open Order` : ''
        log.error(`Refresh run stopped, its lock lost: the run that took it over raises the rest${check}`)
        return
    }
}
```

Its test, which the new tests copy. The outer `withLock` plays the other run. The job called inside
it finds the lock held:

```ts
// src/server/platform/oem-sync.test.ts:85-94
    it('asks nothing while another run holds its lock, and says so', () => {
        enable('cisco')
        staleAsset('foc1', 'cisco')

        const other = withLock(LOCK.oemCoverageRun(), () => syncCoverage())

        expect(other.ran).toBe(true)
        expect(sent).toEqual([])
        expect(platform.logs).toContainEqual(expect.stringContaining(LOCK.oemCoverageRun()))
    })
```

### The three jobs today

The lease review. It checks `!openDecision(leaseId)` and then raises, with no lock:

```ts
// src/server/platform/leases.ts:50-73
/**
 * Flag leases that end before the service they support, raise decisions ahead of lease ends, and queue the transfer
 * again for a bought-out lease that still has Assets (an update was refused): the daily review.
 */
export function runLeaseReview(): void {
    resumeBuyouts()
    const today = todayIso()
    const lease = new GlideRecord(LEASE)
    lease.addQuery('end_action', LEASE_END_ACTION.undecided)
    lease.addNotNullQuery('ends')
    lease.addQuery('ends', '>=', earliestReviewedEnd(today))
    lease.query()
    while (lease.next()) {
        const leaseId = lease.getUniqueValue()
        const mismatch = leaseMismatch(str(lease, 'ends'), serviceEnds(leaseId))
        if (mismatch !== bool(lease, 'mismatch')) {
            lease.setValue('mismatch', mismatch)
            // Refused: tomorrow's review alerts again, which beats not alerting at all.
            if (!lease.update()) warnRefused(lease, `Lease ${str(lease, 'number')} mismatch flag not saved`)
            if (mismatch) fire(EVENT.leaseMismatch, lease, assetManagerIds().join(','))
        }
        if (withinLead(str(lease, 'ends'), today, num(lease, 'decision_lead_days')) && !openDecision(leaseId)) raiseDecision(lease, mismatch)
    }
}
```

`leases.ts` already imports `HeldLock` (line 3) and `log` (line 29). It imports neither `LOCK` nor
`withLock`.

The attestation job. It checks `exists(ATTESTATION, ...)` and then opens, with no lock:

```ts
// src/server/platform/attestations.ts:30-55
/**
 * Open an attestation for each Site with fleet assets of an attesting Agreement, once none is open there and the last
 * one was attested longer ago than the Agreement's interval (or never). One attestation covers every fleet asset
 * installed at the Site, so a Site that several Agreements serve follows the shortest of their intervals; the
 * attestation records the Agreement whose interval raised it.
 */
export function raiseDueAttestations(): void {
    const today = todayIso()
    const agreement = new GlideRecord('x_daas_ham_agreement')
    agreement.addEncodedQuery(ACTIVE_AGREEMENTS)
    agreement.addQuery('attestation_interval_months', '>', 0)
    agreement.query()
    while (agreement.next()) {
        const sites = new Set<string>()
        const asset = new GlideRecord('alm_hardware')
        asset.addEncodedQuery(fleetStagesQuery(IN_USE_STAGES, `x_daas_ham_agreement=${agreement.getUniqueValue()}`))
        asset.query()
        while (asset.next()) if (str(asset, 'x_daas_ham_site')) sites.add(str(asset, 'x_daas_ham_site'))
        for (const siteId of sites) {
            if (exists(ATTESTATION, `site=${siteId}^${OPEN_ATTESTATIONS}`)) continue
            const last = lastAttestedOn(siteId)
            if (!attestationDue({ lastAttestedOn: last, intervalMonths: num(agreement, 'attestation_interval_months'), today })) continue
            openAttestation(agreement, siteId)
        }
    }
}
```

`attestations.ts` imports `log` (line 14). It imports none of `HeldLock`, `LOCK`, `withLock`.

The overdue-return job. It runs through `runTableJob` (`src/server/platform/chunked.ts:79`), which
keeps a cursor and takes no lock. `handle` reads `escalated`, saves it and fires the notice:

```ts
// src/server/platform/returns.ts:449-456
/** Escalate overdue returns once, then declare the Assets missing and charge the lost-asset fee (the daily job). */
export function chaseOverdue(): void {
    const today = todayIso()
    const grace = intProperty(PROPERTY.returnGraceDays)
    runTableJob({
        job: JOB.chaseOverdueReturns,
        table: RETURN_LINE,
        query: `status=${AWAITED}^return_order.due_back<${today}`,
```

```ts
// src/server/platform/returns.ts:467-474
            const step = overdueStep({ dueDate: line.dueDate, today, graceDays: grace, escalated: bool(returnOrder, 'escalated') })
            if (step === 'escalate') {
                returnOrder.setValue('escalated', true)
                returnOrder.setValue('work_notes', `Return overdue since ${line.dueDate}; customer and account manager notified.`)
                // Not marked escalated, it would be escalated again every day: nobody is told until the mark holds.
                if (!returnOrder.update()) return void warnRefused(returnOrder, `${number} not escalated`)
                const recipients = [...customerAdminIds(str(returnOrder, 'customer')), str(returnOrder, 'agreement.account_manager')]
                fire(EVENT.returnOverdue, returnOrder, recipients.filter(Boolean).join(','), line.assetId)
```

`returns.ts` already imports `LOCK` (line 6), `withLock` (line 49) and `log` (line 57).

The three functions are wired as scheduled scripts by name: `runLeaseReview` in
`src/fluent/leases/logic.now.ts:50-57`, `raiseDueAttestations` in
`src/fluent/assurance/logic.now.ts:69-76`, `chaseOverdue` in `src/fluent/returns/logic.now.ts:51-58`.
Their names and their zero-parameter signatures must not change.

### Documentation to extend

ADR 0013 has one paragraph per run lock. The new paragraphs go after the OEM coverage one:

```md
<!-- docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md:152-157 -->
The OEM coverage run holds `oem_coverage_run` for the whole run, so a run and an *Execute
now* at once never load the same stalest Assets and both insert a serial's new contract: the copy
not updated afterwards would keep a stale coverage end. It holds no other lock when it takes it,
does not retry, and checks nothing when it finds it held. Under it, it saves coverage records and
Assets, and every lock their rules take comes later in the order. A run that has lost it starts no further batch.
A unit is put on a Return order under `return_asset_<Asset sys_id>`: the check that it awaits no other
```

`docs/verify-on-instance.md` has one section per lock. The new section goes after this one:

```md
<!-- docs/verify-on-instance.md:647-653 -->
### Refresh lock

Daily refresh Orders ([how a job lock behaves](#how-a-job-lock-behaves)). The daily *NaaS - raise
refresh orders* run holds the job lock `refresh_orders`. With a row of that name in *Job lock*,
*Execute now* raises nothing. It logs two *Unique Key violation* errors and *[x_daas_ham] Refresh
Orders not raised: another run holds the refresh_orders lock and raises them* (info). Delete the
row and the next run raises them.
```

### Conventions that apply (README.md "Development")

- Lock names live in `domain/lock-names.ts`. Their order is the lock order (ADR 0013).
- A test is a `*.test.ts` file beside the module it tests. A platform test runs against
  `src/server/test-support/fake-glide.ts` and mocks Glide with
  `vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)`.
  The fake throws `fake Glide: ...` on anything it does not know. It runs no business rule.
- A relative import in `src/server` names the `.ts` file (ESLint enforces it).
- `src/server/built-metadata.test.ts` fails when a file under `src/server` is newer than `dist/app`.
  Run `npm run build` before the full test run.
- Comments only for a non-obvious why.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 (needs plan 001; before it, use `npx eslint src`) |
| This plan's tests | `npx vitest run src/server/domain/lock-names.test.ts src/server/platform/leases.test.ts src/server/platform/attestations.test.ts src/server/platform/returns.test.ts` | all pass |
| Build | `npm run build` | exit 0; rewrites `dist/` |
| Full gate | `npm run check` | exit 0; all tests pass |

## Scope

**In scope** (the only files you should modify):

- `src/server/domain/lock-names.ts`
- `src/server/domain/lock-names.test.ts`
- `src/server/platform/leases.ts`
- `src/server/platform/leases.test.ts` (create)
- `src/server/platform/attestations.ts`
- `src/server/platform/attestations.test.ts` (create)
- `src/server/platform/returns.ts` (only `chaseOverdue`)
- `src/server/platform/returns.test.ts` (append one `describe`, add one import)
- `docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md`
- `docs/verify-on-instance.md`

**Out of scope** (do NOT touch, even though they look related):

- `src/server/platform/chunked.ts`. `runTableJob` stays lock-free. Other scheduled jobs use it and
  are not part of this finding.
- `src/server/platform/locks.ts` and `src/server/domain/job-lock.ts`. The lock mechanism is right.
- Any `src/fluent` file. The jobs stay wired to the same three function names. No Fluent record is
  added, so `src/fluent/generated/keys.ts` must not change.
- The other scheduled jobs (scheduled returns, renewals, coverage warnings, reconciliation). They
  were not shown to have a check-then-create race. Do not add locks to them here.
- `raiseDecision`, `openAttestation`, `declareMissing` and every other function of the three
  modules. Only the three job entry points change.

## Git workflow

- Branch: `advisor/008-job-run-locks`, from `main`.
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example
  `Hold a run lock in the lease, attestation and overdue-return jobs`. The body says what was wrong
  and why (two runs at once, what each duplicated).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Branch and confirm the baseline

```sh
git checkout main && git checkout -b advisor/008-job-run-locks
npx vitest run src/server/domain/lock-names.test.ts src/server/platform/returns.test.ts
```

**Verify**: all tests pass, 0 failed (at the planned-at commit: 6 in `lock-names.test.ts`, 5 in
`returns.test.ts`).

### Step 2: Declare the three lock names

In `src/server/domain/lock-names.ts`, insert these six lines directly after the `oemCoverageRun`
line (line 29) and before the `seenAsset` doc comment. The position is part of the change: it is
the lock order.

```ts
    /** Held by a lease review throughout, so two runs never raise two decisions for one lease. */
    leaseReviewRun: () => named('lease_review_run'),
    /** Held by an attestation run throughout, so two runs never open two attestations for one Site. */
    attestationRun: () => named('attestation_run'),
    /** Held by an overdue-returns run throughout, so two runs never escalate one Return order twice. */
    overdueReturnsRun: () => named('overdue_returns_run'),
```

In `src/server/domain/lock-names.test.ts`, in the test `names each lock as the locks held across an
upgrade are named`, insert these three lines directly after the `LOCK.oemCoverageRun()` line
(line 35):

```ts
        expect(LOCK.leaseReviewRun()).toBe('lease_review_run')
        expect(LOCK.attestationRun()).toBe('attestation_run')
        expect(LOCK.overdueReturnsRun()).toBe('overdue_returns_run')
```

Change nothing else in the test file. Its other tests read `LOCK` by reflection and need no edit.

**Verify**: `npx vitest run src/server/domain/lock-names.test.ts` → 6 passed.

### Step 3: Write the failing tests

Create `src/server/platform/leases.test.ts` with exactly this content:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCK } from '../domain/lock-names.ts'
import { runLeaseReview } from './leases.ts'
import { withLock } from './locks.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const LEASES = 'x_daas_ham_lease_schedule'
const DECISIONS = 'x_daas_ham_lease_decision'
const LOCKS = 'x_daas_ham_job_lock'

const rows = (table: string): Row[] => platform.tables[table] ?? []

/** An undecided lease that ends within its decision lead time, with no decision open. */
function lease(id: string): Row {
    return { sys_id: id, number: id.toUpperCase(), end_action: 'undecided', ends: '2026-12-01', decision_lead_days: '90', mismatch: 'false' }
}

beforeEach(() => {
    platform.reset()
    platform.clock = Date.parse('2026-11-11T05:35:00Z')
    platform.uniqueKeys = { [LOCKS]: 'name' }
    // The platform sets a task active as it is inserted.
    platform.defaults = { [DECISIONS]: () => ({ active: 'true' }) }
    platform.references = { 'alm_hardware.x_daas_ham_lease': LEASES }
    platform.tables[LEASES] = [lease('ls1')]
})

describe('the daily lease review', () => {
    it('raises the decision of a lease that ends within its lead time, once, and lets its run lock go', () => {
        runLeaseReview()
        runLeaseReview()

        expect(rows(DECISIONS).map((decision) => decision.lease)).toEqual(['ls1'])
        expect(rows(LOCKS)).toEqual([])
    })

    it('raises nothing while another run holds its lock, and says so', () => {
        const other = withLock(LOCK.leaseReviewRun(), () => runLeaseReview())

        expect(other.ran).toBe(true)
        expect(rows(DECISIONS)).toEqual([])
        expect(platform.logs).toContainEqual(expect.stringContaining(LOCK.leaseReviewRun()))
    })

    it('raises no further decision once it has lost its lock', () => {
        rows(LEASES).push(lease('ls2'))
        // The run's lock is taken as abandoned and cleared while its first decision is saved.
        platform.onSave = (table) => {
            if (table === DECISIONS) platform.tables[LOCKS] = []
        }

        runLeaseReview()

        expect(rows(DECISIONS).map((decision) => decision.lease)).toEqual(['ls1'])
        expect(platform.warnings).toEqual([expect.stringContaining('Lease review stopped')])
    })
})
```

Create `src/server/platform/attestations.test.ts` with exactly this content:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fieldsOf } from '../domain/lifecycle.ts'
import { LOCK } from '../domain/lock-names.ts'
import { raiseDueAttestations } from './attestations.ts'
import { withLock } from './locks.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const ATTESTATIONS = 'x_daas_ham_attestation'
const ITEMS = 'x_daas_ham_attestation_item'
const LOCKS = 'x_daas_ham_job_lock'

const rows = (table: string): Row[] => platform.tables[table] ?? []

/** A fleet asset in service at a Site, under the attesting Agreement ag1. */
function installed(id: string, siteId: string): Row {
    const { installStatus, substatus } = fieldsOf('in_service')
    return { sys_id: id, x_daas_ham_fleet: 'true', x_daas_ham_agreement: 'ag1', x_daas_ham_site: siteId, install_status: installStatus, substatus: substatus ?? '' }
}

beforeEach(() => {
    platform.reset()
    platform.clock = Date.parse('2026-11-11T06:10:00Z')
    platform.uniqueKeys = { [LOCKS]: 'name' }
    // The platform sets a task active as it is inserted.
    platform.defaults = { [ATTESTATIONS]: () => ({ active: 'true' }) }
    platform.tables.x_daas_ham_agreement = [{ sys_id: 'ag1', state: 'active', attestation_interval_months: '12', customer: 'acme' }]
    platform.tables.alm_hardware = [installed('a1', 'site1')]
})

describe('the daily attestation run', () => {
    it('opens one attestation for a Site never attested, listing its installed Assets, and lets its run lock go', () => {
        raiseDueAttestations()
        raiseDueAttestations()

        expect(rows(ATTESTATIONS).map((attestation) => attestation.site)).toEqual(['site1'])
        expect(rows(ITEMS).map((item) => item.asset)).toEqual(['a1'])
        expect(rows(LOCKS)).toEqual([])
    })

    it('opens nothing while another run holds its lock, and says so', () => {
        const other = withLock(LOCK.attestationRun(), () => raiseDueAttestations())

        expect(other.ran).toBe(true)
        expect(rows(ATTESTATIONS)).toEqual([])
        expect(platform.logs).toContainEqual(expect.stringContaining(LOCK.attestationRun()))
    })

    it('opens no further attestation once it has lost its lock', () => {
        rows('alm_hardware').push(installed('a2', 'site2'))
        // The run's lock is taken as abandoned and cleared while its first attestation is saved.
        platform.onSave = (table, _row, operation) => {
            if (table === ATTESTATIONS && operation === 'insert') platform.tables[LOCKS] = []
        }

        raiseDueAttestations()

        expect(rows(ATTESTATIONS).map((attestation) => attestation.site)).toEqual(['site1'])
        expect(platform.warnings).toEqual([expect.stringContaining('Attestation run stopped')])
    })
})
```

In `src/server/platform/returns.test.ts`, add this import directly above the existing
`import { chaseOverdue, raiseReturn, requestReturn } from './returns.ts'` line:

```ts
import { withLock } from './locks.ts'
```

and append this block to the end of the file:

```ts
describe('the daily chase of overdue returns', () => {
    beforeEach(() => {
        platform.references = { [`${RETURN_LINES}.return_order`]: RETURNS, [`${RETURNS}.agreement`]: 'x_daas_ham_agreement' }
        platform.clock = Date.parse('2026-11-11T05:20:00Z')
        platform.tables.alm_hardware = [unit('pending_return')]
        // Due back ten days ago: overdue, and within the 14 days of grace before the unit is declared missing.
        platform.tables[RETURNS] = [{ sys_id: 'retA', number: 'RET0001', customer: 'acme', due_back: '2026-11-01', escalated: 'false' }]
        platform.tables[RETURN_LINES] = [{ sys_id: 'lineA', return_order: 'retA', asset: 'a1', status: 'awaiting' }]
    })

    const notices = () => platform.events.filter((event) => event.name === 'x_daas_ham.return.overdue')

    it('escalates an overdue Return order once, and lets its run lock go', () => {
        chaseOverdue()
        chaseOverdue()

        expect(rows(RETURNS)[0]?.escalated).toBe('true')
        expect(notices()).toHaveLength(1)
        expect(rows(LOCKS)).toEqual([])
    })

    it('chases nothing while another run holds its lock, and says so', () => {
        const other = withLock(LOCK.overdueReturnsRun(), () => chaseOverdue())

        expect(other.ran).toBe(true)
        expect(rows(RETURNS)[0]?.escalated).toBe('false')
        expect(notices()).toEqual([])
        expect(platform.logs).toContainEqual(expect.stringContaining(LOCK.overdueReturnsRun()))
    })
})
```

**Verify**: `npx vitest run src/server/platform/leases.test.ts src/server/platform/attestations.test.ts src/server/platform/returns.test.ts`
→ 5 failed, every other test passed (`5 failed | 8 passed` at the planned-at commit; more passed
if another plan added tests to `returns.test.ts`). The five failures are exactly:

- `the daily lease review > raises nothing while another run holds its lock, and says so`
- `the daily lease review > raises no further decision once it has lost its lock`
- `the daily attestation run > opens nothing while another run holds its lock, and says so`
- `the daily attestation run > opens no further attestation once it has lost its lock`
- `the daily chase of overdue returns > chases nothing while another run holds its lock, and says so`

Each fails because the job did its work although the lock was held or lost. That is the bug. If
the set of failures differs, STOP.

### Step 4: Hold the run lock in the lease review

Edit `src/server/platform/leases.ts`.

Add two imports, each on its own line, placed so the import block stays readable (for example
`LOCK` after the `../domain/lifecycle.ts` import and `withLock` after the `./lifecycle-dates.ts`
import):

```ts
import { LOCK } from '../domain/lock-names.ts'
import { withLock } from './locks.ts'
```

Replace the doc comment and the first line of `runLeaseReview` (lines 50-55) so the function
becomes a lock wrapper and its old body becomes `reviewHolding`:

```ts
/**
 * Flag leases that end before the service they support, raise decisions ahead of lease ends, and queue the transfer
 * again for a bought-out lease that still has Assets (an update was refused): the daily review. Two runs at once (the
 * scheduled job and an *Execute now*) would both find a lease with no open decision and raise one each, so a run holds
 * a job lock (ADR 0013) throughout; one that finds it held reviews nothing and logs so. Taking the lock throws only
 * when an insert is refused with no lock row (platform/locks): that error escapes.
 */
export function runLeaseReview(): void {
    const lockName = LOCK.leaseReviewRun()
    if (withLock(lockName, reviewHolding).ran) return
    log.info(`Leases not reviewed: another run holds the ${lockName} lock and reviews them`)
}

/** The review, holding the run's `lock`. A run that outlasts it (ADR 0013) raises no decision once it has lost it. */
function reviewHolding(lock: HeldLock): void {
    resumeBuyouts()
```

The rest of the old body follows unchanged, except its last statement. Replace

```ts
        if (withinLead(str(lease, 'ends'), today, num(lease, 'decision_lead_days')) && !openDecision(leaseId)) raiseDecision(lease, mismatch)
```

with

```ts
        if (!withinLead(str(lease, 'ends'), today, num(lease, 'decision_lead_days')) || openDecision(leaseId)) continue
        if (!lock.held()) return void log.warn('Lease review stopped, its lock lost: the run that took it over raises the rest')
        raiseDecision(lease, mismatch)
```

**Verify**: `npx vitest run src/server/platform/leases.test.ts` → 3 passed.

### Step 5: Hold the run lock in the attestation job

Edit `src/server/platform/attestations.ts`.

Add three imports:

```ts
import type { HeldLock } from '../domain/job-lock.ts'
import { LOCK } from '../domain/lock-names.ts'
import { withLock } from './locks.ts'
```

Replace the end of the doc comment and the head of `raiseDueAttestations` (lines 34-37) with:

```ts
 * attestation records the Agreement whose interval raised it. Two runs at once (the scheduled job and an *Execute now*)
 * would both find a Site with none open and open one each, so a run holds a job lock (ADR 0013) throughout; one that
 * finds it held opens nothing and logs so. Taking the lock throws only when an insert is refused with no lock row
 * (platform/locks): that error escapes.
 */
export function raiseDueAttestations(): void {
    const lockName = LOCK.attestationRun()
    if (withLock(lockName, raiseHolding).ran) return
    log.info(`Attestations not raised: another run holds the ${lockName} lock and raises them`)
}

/** The run, holding its `lock`. One that outlasts it (ADR 0013) opens no attestation once it has lost it. */
function raiseHolding(lock: HeldLock): void {
    const today = todayIso()
```

The rest of the old body follows unchanged, with one line added directly above
`openAttestation(agreement, siteId)`:

```ts
            if (!lock.held()) return void log.warn('Attestation run stopped, its lock lost: the run that took it over raises the rest')
            openAttestation(agreement, siteId)
```

**Verify**: `npx vitest run src/server/platform/attestations.test.ts` → 3 passed.

### Step 6: Hold the run lock in the overdue-return job

Edit `src/server/platform/returns.ts`. Replace the one-line doc comment and the signature line of
`chaseOverdue` (lines 449-450) with:

```ts
/**
 * Escalate overdue returns once, then declare the Assets missing and charge the lost-asset fee (the daily job). Two
 * runs at once (the scheduled job and an *Execute now*) would both read a Return order as not escalated and each notify
 * its Customer, and both advance the job's one cursor, so a run holds a job lock (ADR 0013) throughout; one that finds
 * it held chases nothing and logs so. Taking the lock throws only when an insert is refused with no lock row
 * (platform/locks): that error escapes.
 */
export function chaseOverdue(): void {
    const lockName = LOCK.overdueReturnsRun()
    if (withLock(lockName, chaseHolding).ran) return
    log.info(`Overdue returns not chased: another run holds the ${lockName} lock and chases them`)
}

function chaseHolding(): void {
```

The old body (`const today = todayIso()` through the closing `}` of the function) follows
unchanged, now as the body of `chaseHolding`. No import changes: `LOCK`, `withLock` and `log` are
imported already.

This run does not check for a lost lock. `runTableJob` ends a run when the job time budget
(`x_daas_ham.job.budget_seconds`, 120 seconds as shipped) is spent, well short of the 10 minutes
after which a lock is taken as abandoned.

**Verify**: `npx vitest run src/server/platform/leases.test.ts src/server/platform/attestations.test.ts src/server/platform/returns.test.ts`
→ 0 failed (`13 passed` at the planned-at commit).

### Step 7: Document the three locks

In `docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md`, insert the following three
paragraphs between the line that ends `A run that has lost it starts no further batch.` (line 156)
and the line that starts `A unit is put on a Return order under` (line 157). Keep them as plain
lines with no blank line between them, like the paragraphs around them:

```md
The daily lease review holds `lease_review_run` for the whole run, so a run and an *Execute now* at
once never both find a lease with no open decision and raise one each: the second would stay open
once the first is applied, could be applied again, and would keep the review from raising the next.
It holds no other lock when it takes it, does not retry, and reviews nothing when it finds it held.
Under it, it saves Lease schedules and inserts decisions, whose rules take no lock. A run that has
lost it raises no further decision.
The daily attestation run holds `attestation_run` for the whole run, so a run and an *Execute now*
at once never both find a Site with no open attestation and open one each. It holds no other lock
when it takes it, does not retry, and opens nothing when it finds it held. Under it, it inserts
attestations and their items, whose rules take no lock. A run that has lost it opens no further
attestation.
The daily chase of overdue returns holds `overdue_returns_run` for the whole run, so a run and an
*Execute now* at once never both read a Return order as not escalated and notify its Customer
twice, nor both advance the job's one cursor. It holds no other lock when it takes it, does not
retry, and chases nothing when it finds it held. Under it, it declares each unit missing under that
unit's `receive_asset_` lock, with what that takes under it, so it comes before `receive_asset`. A
run ends on the job time budget (`x_daas_ham.job.budget_seconds`), well short of
`ABANDONED_AFTER_MINUTES`, so it does not check for a lost lock.
```

In `docs/verify-on-instance.md`, insert this section after the `### Refresh lock` section (after
line 653, before `### Spare-pool lock`), with one blank line before and after it:

```md
### Lease review, attestation and overdue-return run locks

[How a job lock behaves](#how-a-job-lock-behaves). The daily *NaaS - review leases*, *NaaS - raise
attestations* and *NaaS - chase overdue returns* runs each hold a job lock for the whole run:
`lease_review_run`, `attestation_run` and `overdue_returns_run`. With a row of that name in *Job
lock*, *Execute now* on its job does nothing. It logs two *Unique Key violation* errors and
*[x_daas_ham] Leases not reviewed: another run holds the lease_review_run lock and reviews them*,
*Attestations not raised: another run holds the attestation_run lock and raises them* or *Overdue
returns not chased: another run holds the overdue_returns_run lock and chases them* (info). Delete
the row and the next run does the work.
```

**Verify**: `grep -E -o "lease_review_run|attestation_run|overdue_returns_run" docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md | wc -l`
→ `3`, and `grep -c "### Lease review, attestation and overdue-return run locks" docs/verify-on-instance.md` → `1`.

### Step 8: Run the full gate and commit

```sh
npm run check
git status --short
```

**Verify**: `npm run check` exits 0. `git status --short` lists only the ten in-scope files. If
`src/fluent/generated/keys.ts` shows as modified, see the STOP conditions.

Commit all ten files in one commit, with the subject from "Git workflow" and a body that says what
was wrong and why.

## Test plan

- `src/server/domain/lock-names.test.ts`: three assertions added, one per new name.
- `src/server/platform/leases.test.ts` (new, 3 tests), `src/server/platform/attestations.test.ts`
  (new, 3 tests), modelled on `src/server/platform/oem-sync.test.ts`:
  - a run does its work once and releases its lock (the second run finds the decision or the
    attestation open and raises nothing more);
  - a run that finds its lock held does nothing and logs the lock's name;
  - a run that loses its lock midway stops before the next raise, with a warning.
- `src/server/platform/returns.test.ts` (2 tests appended):
  - a run escalates an overdue Return order once, fires one notice and releases its lock;
  - a run that finds its lock held escalates nothing, fires nothing and logs the lock's name.
- Verification: `npx vitest run src/server/domain/lock-names.test.ts src/server/platform/leases.test.ts src/server/platform/attestations.test.ts src/server/platform/returns.test.ts`
  → 0 failed (19 passed at the planned-at commit: 6, 3, 3 and 7).

What the tests cannot show: the fake Glide is single-threaded, so two runs never truly overlap.
The tests show that a run takes the lock, does nothing when it is held, and stops when it is lost.
That the lock row excludes a second run on a real instance rests on the unique index, which the
existing run locks already rely on.

Local and instance checks: every done criterion below is local. The instance check is the new
section of `docs/verify-on-instance.md` (create a *Job lock* row by hand, *Execute now*, read the
log). It is optional for handing the work back. Say in your report whether it was run.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] The test command in the test plan reports 0 failed, and the 8 new tests are among those passed
- [ ] `npm run check` exits 0
- [ ] `grep -E -n "leaseReviewRun|attestationRun|overdueReturnsRun" src/server/domain/lock-names.ts` shows the three declarations on consecutive entries between `oemCoverageRun` and `seenAsset`
- [ ] `grep -c "withLock(lockName" src/server/platform/leases.ts src/server/platform/attestations.ts src/server/platform/returns.ts` prints `1` for each file
- [ ] `git diff --stat main..HEAD -- src/fluent` prints nothing
- [ ] `git status --short` is empty and only the ten in-scope files differ from `main`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts.
- `LOCK` in `lock-names.ts` already has a run lock for one of these jobs, or its entries around
  `oemCoverageRun` and `seenAsset` are in a different order than quoted. The position decides the
  lock order, so do not guess a new one.
- Step 3 gives a different set of failing tests than the five listed.
- A test fails with a message that starts with `fake Glide:`. Report the message. Do not extend
  `fake-glide.ts` under this plan.
- You find that one of the three jobs takes `refresh_orders`, `agreement_usage_`, `oem_claim_run`
  or `oem_coverage_run` while it runs (search the functions it calls for `LOCK.`). The position
  chosen for the new locks would then break the lock order.
- A change seems to need a new parameter on `runLeaseReview`, `raiseDueAttestations` or
  `chaseOverdue`, or a change in `src/fluent`. The scheduled scripts call them with no arguments.
- `npm run build` leaves `src/fluent/generated/keys.ts` modified. Report the diff.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- A new lock taken by one of these three jobs must be declared after its run lock in `LOCK`. A lock
  declared before it (today: `refresh_orders`, `agreement_usage_`, `oem_claim_run`,
  `oem_coverage_run`) cannot be taken under it.
- Plan 009 (`plans/009-fee-lock-waive-close.md`) edits `lock-names.ts` and ADR 0013 as well. It
  expects this plan to have landed first.
- If the overdue-return job's time budget is ever raised near `ABANDONED_AFTER_MINUTES` (10
  minutes), give `chaseHolding` the lost-lock check the other two have. Today the budget keeps a
  run far shorter than that.
- A run that dies holding its lock keeps the job from running for up to 10 minutes. The next
  scheduled run is a day later, so nothing is lost. An *Execute now* inside those 10 minutes logs
  that another run holds the lock.
- A reviewer should check three things: the position of the three names in `LOCK`, that the log
  lines match the tests and `docs/verify-on-instance.md` word for word, and that the body of each
  job is otherwise unchanged (the diff of each function should show only the wrapper and the
  lost-lock line).
- Deferred: the other scheduled jobs were not audited for the same race. If one is found to check
  and then create, it takes the same pattern.
