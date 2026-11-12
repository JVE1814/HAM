# Plan 038: Read scheduled returns on from where the last run stopped, so records left behind never block the rest

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- src/server/platform/scheduled-returns.ts src/server/platform/scheduled-returns.test.ts src/server/domain/chunked-job.ts src/server/platform/job-cursor.ts docs/adr/0007-chunked-jobs-with-persistent-cursors.md docs/spec/p2-aftersales.md docs/verify-on-instance.md`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition. (Plan 028 edits the bullet directly
> below the one this plan edits in ADR 0007. That alone is not a mismatch if
> the *Scheduled returns* bullet still reads as quoted below. Step 4 replaces
> `scheduled-returns.ts` whole, so any change to that file is a mismatch.)

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

The daily job *NaaS - raise agreement-end and temporary-end returns* recovers equipment: it raises
Return orders for Agreements that have ended and for temporary Orders that are ending. Each run
reads at most 50 Agreements and 50 Orders, always starting from the first. A record whose Return
was raised is marked and drops out. A record the run cannot finish is left unmarked and is read
again, first, by every later run.

Two kinds of record are left that way: an Agreement or Order whose Return or mark the platform
refused, and a temporary Order still being installed. Fifty of them fill the whole page. From then
on no run reads past them, the equipment of every later Agreement and Order is never recovered,
and nothing is logged about it. Equipment that is not recovered stays at the Customer after the
contract ended, unbilled.

This plan makes each run read on from where the last one stopped, and start over after the last
record. Records left behind then cost one page of reads per cycle and no longer block anything. A
run that leaves every record it read logs a warning.

## Current state

### The job

`src/server/platform/scheduled-returns.ts` (112 lines) is the whole job. Its entry point is wired
as a scheduled script by name (`src/fluent/returns/logic.now.ts:60-68`, daily at 04:45 UTC):

```ts
// src/server/platform/scheduled-returns.ts:19-23
export function raiseDueReturns(): void {
    const today = todayIso()
    recoverEndedAgreements(today)
    returnTemporaryDeployments(today)
}
```

The ended Agreements. No order is set, the limit is 50, and an Agreement with a refused Return is
skipped with `continue` and never marked:

```ts
// src/server/platform/scheduled-returns.ts:33-42
function recoverEndedAgreements(today: string): void {
    const agreement = new GlideRecord('x_daas_ham_agreement')
    agreement.addQuery('ends', '<', today)
    agreement.addQuery(END_RETURN_RAISED, false)
    agreement.addNotNullQuery('ends')
    agreement.setLimit(50)
    agreement.query()
    while (agreement.next()) {
        const agreementId = agreement.getUniqueValue()
        const recover = `Agreement ${str(agreement, 'number')} ended ${str(agreement, 'ends')}: recover all equipment`
```

```ts
// src/server/platform/scheduled-returns.ts:63-70
            if (!raised) refused = true
        }
        // A refused Return is raised on the next run. Units put on a Return now are pending return, so not found again.
        if (refused) continue
        agreement.setValue(END_RETURN_RAISED, true)
        // Refused, the next run finds the Agreement again, raises no Return twice (above) and saves the mark again.
        if (!agreement.update()) warnRefused(agreement, `Agreement ${str(agreement, 'number')} not marked as its end Returns raised`)
    }
```

The temporary Orders. They are ordered by end date with a limit of 50, and an Order still being
installed, or one whose Return was refused, is skipped without a mark:

```ts
// src/server/platform/scheduled-returns.ts:76-92
    const order = new GlideRecord('x_daas_ham_order')
    const temporary: OrderType = 'temporary'
    order.addQuery('order_type', temporary)
    order.addQuery('return_raised', false)
    order.addNotNullQuery('end_date')
    order.addQuery('end_date', '<=', horizon)
    order.addQuery('stage', 'IN', TEMPORARY_RETURN_STAGES.join(','))
    order.orderBy('end_date')
    order.setLimit(50)
    order.query()
    while (order.next()) {
        const orderId = order.getUniqueValue()
        const assetIds = installedAssetIds({ orderId, stages: stagesTakenBack('temporary_end') })
        // The Return is raised once, so an Order still being installed waits until every unit is installed. Once its
        // end date has passed, the units still shipped come back too.
        const installing = str(order, 'stage') === ORDER_STAGE.installing && str(order, 'end_date') >= today
        if (installing && (assetIds.length === 0 || installedAssetIds({ orderId }).length < assetIds.length)) continue
```

So the first 50 records by the database's order (Agreements) or by end date (Orders) are the only
ones a run ever sees, for as long as none of them is marked.

### What ADR 0007 says, and the precedent to copy

ADR 0007 is the decision that bulk work is bounded and keeps a persistent cursor. Its bullet for
this job describes only the limit:

```md
<!-- docs/adr/0007-chunked-jobs-with-persistent-cursors.md:44-46 -->
- Scheduled returns (`platform/scheduled-returns.ts` `raiseDueReturns`) take a limited number of ended
  Agreements and of ending temporary Orders a run (the limits are in that module); each one raised
  is flagged and drops out.
```

The same ADR already describes the shape this plan needs, for another job:

```md
<!-- docs/adr/0007-chunked-jobs-with-persistent-cursors.md:38-43 -->
- OEM claim and provisioning (`platform/claim-steps.ts` `runClaims`) makes at most
  `x_daas_ham.oem.claim.max_calls` adapter calls per vendor a run, holding its run lock. Before them
  it checks a capped number of waiting steps (`STRANDED_LOAD`) for stranded ones, in sys_id order
  from where the last run stopped
  (the `x_daas_ham_job_cursor` row `oem_claim_stranded`, which holds only that position), starting
  over after the last.
```

That code is the model: a capped read in sys_id order, after a position kept in a job-cursor row,
starting over when nothing is left after it.

```ts
// src/server/platform/claim-steps.ts:130-135
function releaseStranded(): void {
    const cursor = strandedCursor()
    const after = cursor?.cursor ?? ''
    let steps = waitingSteps(after)
    if (steps.length === 0 && after) steps = waitingSteps('')
    if (cursor) saveStrandedCursor(cursor, steps.length === STRANDED_LOAD ? (steps[steps.length - 1]?.stepId ?? '') : '')
```

```ts
// src/server/platform/claim-steps.ts:167-180
function strandedCursor(): JobCursor | null {
    try {
        return openJobCursor(JOB.oemClaimStranded)
    } catch (error) {
        log.warn(`Job cursor ${JOB.oemClaimStranded} not created, so each claim run checks the same waiting steps: ${messageOf(error)}`)
        return null
    }
}

function saveStrandedCursor(cursor: JobCursor, next: string): void {
    if (cursor.cursor === next) return
    const refused = cursor.save({ cursor: next })
    if (refused) log.warn(`Job cursor ${JOB.oemClaimStranded} not saved, so the next claim run checks the same waiting steps: ${refused}`)
}
```

`openJobCursor(job)` (`src/server/platform/job-cursor.ts:50`) gives the job's row in
`x_daas_ham_job_cursor`, creating it on first use, and throws when it cannot. A `JobCursor` has a
`cursor` string and `save({ cursor })`, which returns null once saved or the reason it was refused.
Only `job-cursor.ts` reads and writes that table.

Every row is named in `JOB`:

```ts
// src/server/domain/chunked-job.ts:8-19
export const JOB = {
    normalizeRawModels: 'normalize_raw_models',
    inServiceDetection: 'in_service_detection',
    chaseOverdueReturns: 'chase_overdue_returns',
    reconcileInstalledBase: 'reconcile_installed_base',
    sparePoolTopUp: 'spare_pool_top_up',
    providerTagSequence: 'provider_tag_sequence',
    oemClaimStranded: 'oem_claim_stranded',
    preflight: 'preflight',
    margin: (periodId: string) => `margin_${periodId}`,
    billingGenerate: (periodId: string) => `billing_generate_${periodId}`,
} as const
```

A test in `src/server/domain/chunked-job.test.ts` (`gives every job a row of its own, ...`) reads
`JOB` by reflection and fails on a duplicate name. It needs no edit.

`job-cursor.ts` lists what each row's `cursor` holds. This plan adds one line to that list:

```ts
// src/server/platform/job-cursor.ts:12-14
 * - `JOB.providerTagSequence` (platform/tags): the last Provider tag number issued;
 * - `JOB.oemClaimStranded` (platform/claim-steps): the last waiting step a claim run checked, '' once it checked them all;
 * - `JOB.preflight` (entry/preflight): nothing, its result is the row's `last_status`.
```

### Why this design, and what was passed over

- **A position in a job-cursor row, the limit of 50 kept (chosen).** It is the shape ADR 0007
  already records for the stranded-step check. A run still does at most 50 Agreements' and 50
  Orders' worth of work, as today. Each record gets its turn within a number of runs equal to the
  records waiting divided by 50, rounded up.
- **Order by `sys_updated_on` and save each skipped record.** That writes to an Agreement or an
  Order every day only to move it in a queue. Each save runs the table's rules and adds an audit
  entry. Passed over.
- **`visitInKeyOrder`** (`src/server/platform/chunked.ts:340`). It visits every matching record in
  one transaction with no cap. Each record here can raise Return orders, a change and a work
  order, so an uncapped run is the opposite of what ADR 0007 asks. Passed over.
- **`runTableJob`** (`chunked.ts:79`). It has a cursor, but it bounds a run by time (120 seconds
  as shipped), not by count. That changes how much this job does in one run, a wider change than
  the finding needs. Passed over.

The cost of the choice: temporary Orders are no longer read earliest end date first. While 50 or
fewer are waiting, a run reads them all, so the order does not matter. Above 50, an Order waits
for its turn, at most the number of runs given above. The job looks ahead
`x_daas_ham.returns.temporary_lead_days` days (7 as shipped), so up to 350 waiting Orders are all
read before their end dates.

The job holds no run lock, and this plan adds none. Two runs at once read the same position and
the same page, as two runs read the same first page today.

### The existing tests

`src/server/platform/scheduled-returns.test.ts` has 4 tests, all on one temporary Order. Its
helpers, which the new tests reuse:

```ts
// src/server/platform/scheduled-returns.test.ts:16-21
const rows = (table: string): Row[] => platform.tables[table] ?? []

function unit(sysId: string, line: string, stage: Stage): Row {
    const { installStatus, substatus } = fieldsOf(stage)
    return { sys_id: sysId, serial_number: sysId.toUpperCase(), x_daas_ham_fleet: 'true', x_daas_ham_order_line: line, x_daas_ham_site: 's1', x_daas_ham_agreement: 'ag1', install_status: installStatus, substatus: substatus ?? '' }
}
```

```ts
// src/server/platform/scheduled-returns.test.ts:29-30
const returned = () => rows(RETURN_LINES).map((line) => line.asset)
const marked = () => String(rows(ORDERS)[0]?.return_raised)
```

Its `beforeEach` (lines 32 to 44) resets the fake, sets `platform.uniqueKeys`, `platform.defaults`
and `platform.references`, and stores one Order with two lines. No test covers ended Agreements or
more than one Order.

### Documentation to change

The ADR 0007 bullet quoted above (lines 44 to 46).

`docs/spec/p2-aftersales.md` has a table of Return triggers under `## Returns (Q60)`. Its last row
starts `| Temporary end | Daily job, ...`. A blank line follows, and then a bullet that starts
`- Through the record producer, a return is raised only when the Return create rule lets its requester`
(line 81). The new bullet goes directly before that bullet.

`docs/verify-on-instance.md` names the job-cursor rows that are not a scheduled pass:

```md
<!-- docs/verify-on-instance.md:202-205 -->
and each run logs them as an error in the system log. Some rows are no scheduled pass and read
differently: `preflight` holds the preflight check's result, `billing_generate_<period sys_id>` a
billing pass (ADR 0007), `provider_tag_sequence` the Provider tag counter, and `oem_claim_stranded`
only where the OEM claim run's check for stranded steps goes on from, with no status.
```

### Conventions that apply (README.md "Development", AGENTS.md)

- A test is a `*.test.ts` file beside the module it tests. A platform test runs against
  `src/server/test-support/fake-glide.ts`, which throws `fake Glide: ...` on anything it does not
  know and runs no business rule.
- A relative import in `src/server` names the `.ts` file (`./job-cursor.ts`). ESLint enforces it.
- `src/server/domain/` is pure. `JOB` lives there. The cursor code lives in `platform/`.
- `npx vitest run <path>` needs no build. `npm test` and `npm run check` do.
- `npm run build` rewrites the tracked file `src/fluent/generated/keys.ts`. This plan changes no
  Fluent file, so the build must leave it unchanged.
- Comments only for a non-obvious why. Use the words of `CONTEXT.md`: Agreement, Order, Asset,
  Return order.
- When documented behaviour changes, the matching ADR and spec lines change in the same commit.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| This plan's tests | `npx vitest run src/server/platform/scheduled-returns.test.ts src/server/domain/chunked-job.test.ts` | all pass |
| Build | `npm run build` | exit 0; rewrites `dist/` |
| Full gate | `npm run check` | exit 0; all tests pass |

## Scope

**In scope** (the only files you should modify):

- `src/server/domain/chunked-job.ts` (two names added to `JOB`)
- `src/server/platform/scheduled-returns.ts` (replaced whole in step 4)
- `src/server/platform/scheduled-returns.test.ts` (one import and one `describe` added)
- `src/server/platform/job-cursor.ts` (one line of its doc comment)
- `docs/adr/0007-chunked-jobs-with-persistent-cursors.md` (the *Scheduled returns* bullet only)
- `docs/spec/p2-aftersales.md` (one bullet added)
- `docs/verify-on-instance.md` (one sentence changed)

**Out of scope** (do NOT touch, even though they look related):

- `src/server/platform/returns.ts`. `raiseReturn` and the Return's locks stay as they are.
- `src/server/platform/chunked.ts` and `src/server/platform/claim-steps.ts`. The precedent is
  copied, not shared: the two cursors differ in what they log.
- What makes a record wait: the refusal rules and the *still being installed* rule. This plan
  changes only which records a run reads, not what it does with one.
- A run lock for this job. It has none today.
- The *Attestations* bullet of ADR 0007 (lines 47 to 49). Plan 028 owns it.
- `src/fluent/returns/logic.now.ts`. The scheduled script stays wired to `raiseDueReturns`, with
  no arguments. The job-cursor rows are created by the code on first use, not by Fluent records.

## Git workflow

- Branch: `advisor/038-scheduled-returns-rotation`, from `main`.
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example
  `Read scheduled returns on from where the last run stopped`. The body says what was wrong and
  why (50 records left unmarked filled every run's page, so later ones were never read).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Branch and confirm the baseline

```sh
git checkout main && git checkout -b advisor/038-scheduled-returns-rotation
npx vitest run src/server/platform/scheduled-returns.test.ts src/server/domain/chunked-job.test.ts
```

**Verify**: 51 passed, 0 failed (4 and 47 at the planned-at commit).

### Step 2: Name the two job-cursor rows

In `src/server/domain/chunked-job.ts`, insert these two lines in `JOB`, directly after the
`oemClaimStranded` line (line 15):

```ts
    endedAgreementReturns: 'ended_agreement_returns',
    temporaryOrderReturns: 'temporary_order_returns',
```

**Verify**: `npx vitest run src/server/domain/chunked-job.test.ts` → 47 passed.

### Step 3: Write the failing tests

Edit `src/server/platform/scheduled-returns.test.ts`.

Add this import directly above the `import { fieldsOf, type Stage } from '../domain/lifecycle.ts'`
line:

```ts
import { JOB } from '../domain/chunked-job.ts'
```

Append this block to the end of the file, after one blank line:

```ts
describe('more records left for a later run than one run reads', () => {
    const CURSORS = 'x_daas_ham_job_cursor'
    const AGREEMENTS = 'x_daas_ham_agreement'
    const nth = (prefix: string, n: number) => `${prefix}${String(n).padStart(2, '0')}`
    const cursorOf = (job: string) => rows(CURSORS).find((cursor) => cursor.job === job)?.cursor ?? ''

    beforeEach(() => {
        platform.uniqueKeys = { x_daas_ham_job_lock: 'name', [CURSORS]: 'job' }
        platform.clock = Date.parse('2026-12-20T06:00:00Z')
        platform.tables[ORDERS] = []
        platform.tables.x_daas_ham_order_line = []
    })

    it('reaches a temporary Order behind 50 still being installed, on the next run', () => {
        const order = (sysId: string, fields: Row): Row => ({ sys_id: sysId, number: sysId.toUpperCase(), order_type: 'temporary', return_raised: 'false', install_mode: 'self_install', customer: 'c1', site: 's1', agreement: 'ag1', ...fields })
        const installing = Array.from({ length: 50 }, (_, n) => order(nth('o', n + 1), { stage: 'installing', end_date: '2026-12-21' }))
        platform.tables[ORDERS] = [...installing, order('o99', { stage: 'complete', end_date: '2026-12-24' })]
        platform.tables.x_daas_ham_order_line = [{ sys_id: 'l99', number: 'OL99', order: 'o99', quantity: '1', line_stage: 'installed' }]
        platform.tables.alm_hardware = [unit('switch', 'l99', 'temporary_deployment')]

        raiseDueReturns()

        expect(rows(RETURNS)).toEqual([])
        expect(cursorOf(JOB.temporaryOrderReturns)).toBe('o50')
        expect(platform.warnings).toEqual([expect.stringContaining(`${JOB.temporaryOrderReturns}: each of the 50 records read was left for a later run`)])

        raiseDueReturns()

        expect(returned()).toEqual(['switch'])
        expect(rows(ORDERS).find((stored) => stored.sys_id === 'o99')?.return_raised).toBe('true')
        expect(cursorOf(JOB.temporaryOrderReturns)).toBe('')
    })

    it('reaches an ended Agreement behind 50 whose Return is refused, on the next run', () => {
        const agreement = (sysId: string): Row => ({ sys_id: sysId, number: sysId.toUpperCase(), customer: 'c1', ends: '2026-11-30', end_return_raised: 'false' })
        const refusedOnes = Array.from({ length: 50 }, (_, n) => agreement(nth('ag', n + 1)))
        platform.tables[AGREEMENTS] = [...refusedOnes, agreement('ag99')]
        platform.tables.alm_hardware = [...refusedOnes, agreement('ag99')].map((ended) => ({ ...unit(`unit-${ended.sys_id}`, '', 'in_service'), x_daas_ham_agreement: ended.sys_id ?? '' }))
        platform.refuses = (table, row, operation) => (table === RETURNS && operation === 'insert' && row.agreement !== 'ag99' ? 'refused for this test' : '')

        raiseDueReturns()

        expect(rows(RETURNS)).toEqual([])
        expect(cursorOf(JOB.endedAgreementReturns)).toBe('ag50')
        expect(platform.warnings).toContainEqual(expect.stringContaining(`${JOB.endedAgreementReturns}: each of the 50 records read was left for a later run`))

        raiseDueReturns()

        expect(rows(RETURNS).map((raised) => raised.agreement)).toEqual(['ag99'])
        expect(returned()).toEqual(['unit-ag99'])
        expect(rows(AGREEMENTS).find((stored) => stored.sys_id === 'ag99')?.end_return_raised).toBe('true')
        expect(cursorOf(JOB.endedAgreementReturns)).toBe('')
    })

    it('starts over once it has read to the end, so a record left earlier gets its turn again', () => {
        const agreement = (sysId: string): Row => ({ sys_id: sysId, number: sysId.toUpperCase(), customer: 'c1', ends: '2026-11-30', end_return_raised: 'false' })
        platform.tables[AGREEMENTS] = [agreement('ag01'), agreement('ag99')]
        platform.tables.alm_hardware = [{ ...unit('unit-ag01', '', 'in_service'), x_daas_ham_agreement: 'ag01' }]
        platform.tables[CURSORS] = [{ sys_id: 'cur1', job: JOB.endedAgreementReturns, cursor: 'ag99' }]

        raiseDueReturns()

        expect(returned()).toEqual(['unit-ag01'])
        expect(rows(AGREEMENTS).map((stored) => stored.end_return_raised)).toEqual(['true', 'true'])
        expect(cursorOf(JOB.endedAgreementReturns)).toBe('')
    })
})
```

What each test sets up. In the first, 50 Orders are still being installed and end earlier, and
one Order, `o99`, is complete and due. In the second, 50 ended Agreements each have a unit whose
Return the platform refuses, and one, `ag99`, has a unit whose Return is accepted. In both, the
record that is due sorts last by sys_id and, for the Orders, last by end date too, so today's
code never reads it. The third stores a position after the last record and expects the run to
start over.

**Verify**: `npx vitest run src/server/platform/scheduled-returns.test.ts` → `3 failed | 4 passed`.
The three failures are exactly the three new tests, each on its first assertion about the cursor
(`expected '' to be 'o50'`, `expected '' to be 'ag50'`, `expected 'ag99' to be ''`). If the set of
failures differs, STOP.

### Step 4: Read each kind on from the job's cursor

Replace the whole content of `src/server/platform/scheduled-returns.ts` with exactly this. The
logic that handles one Agreement and one Order is the old loop body, moved into a function that
returns whether the record is done with. Only the reading changes.

```ts
import { GlideRecord } from '@servicenow/glide'
import { addDays } from '../domain/calendar.ts'
import { JOB } from '../domain/chunked-job.ts'
import { messageOf } from '../domain/errors.ts'
import { PROPERTY } from '../domain/properties.ts'
import { collectionMethod, stagesTakenBack, TEMPORARY_RETURN_STAGES } from '../domain/returns.ts'
import { type InstallMode, ORDER_STAGE, type OrderType, RETURN_TRIGGER } from '../domain/vocabulary.ts'
import { todayIso } from './clock.ts'
import { installedAssetIds, installedAssetIdsBySite } from './installed-assets.ts'
import { openJobCursor, type JobCursor } from './job-cursor.ts'
import { log } from './log.ts'
import { intProperty } from './properties.ts'
import { exists, findById, str, warnRefused } from './records.ts'
import { raiseReturn, RETURN } from './returns.ts'

/**
 * Each is raised once, which a mark on the Agreement (`end_return_raised`) and on the temporary Order (`return_raised`)
 * records; both marks are read and written here only.
 */

const END_RETURN_RAISED = 'end_return_raised'

/** Ended Agreements, and ending temporary Orders, a run reads at most. */
const PAGE = 50

export function raiseDueReturns(): void {
    const today = todayIso()
    recoverEndedAgreements(today)
    returnTemporaryDeployments(today)
}

/**
 * An Agreement's end date moved to a day it has not ended by: its equipment is recovered again once that day has
 * passed (the caller saves the Agreement).
 */
export function recoverAgainAtEnd(agreement: GlideRecord): void {
    agreement.setValue(END_RETURN_RAISED, false)
}

/**
 * Visit the next PAGE records of `table` that `where` selects, in sys_id order after the last one the run before read
 * (the job cursor `job`, which holds only that position), starting over after the last. `visit` says whether the
 * record is done with (marked, so the next query leaves it out) or left for a later run. A record left (a Return or a
 * mark refused, an Order still being installed) stays in the query: read first by every run, PAGE of them would keep
 * every record after them from ever being read.
 */
function visitNextPage(job: string, table: string, where: (record: GlideRecord) => void, visit: (record: GlideRecord) => boolean): void {
    const cursor = pageCursor(job)
    const after = cursor?.cursor ?? ''
    let page = readPage(table, where, after)
    if (after && !page.hasNext()) page = readPage(table, where, '')
    let read = 0
    let left = 0
    let last = ''
    while (page.next()) {
        read++
        last = page.getUniqueValue()
        if (!visit(page)) left++
    }
    if (cursor) savePageCursor(job, cursor, read === PAGE ? last : '')
    if (left === PAGE) log.warn(`${job}: each of the ${PAGE} records read was left for a later run; the next run reads on after them`)
}

function readPage(table: string, where: (record: GlideRecord) => void, after: string): GlideRecord {
    const record = new GlideRecord(table)
    where(record)
    if (after) record.addQuery('sys_id', '>', after)
    record.orderBy('sys_id')
    record.setLimit(PAGE)
    record.query()
    return record
}

function pageCursor(job: string): JobCursor | null {
    try {
        return openJobCursor(job)
    } catch (error) {
        log.warn(`Job cursor ${job} not created, so each run reads the same records first: ${messageOf(error)}`)
        return null
    }
}

function savePageCursor(job: string, cursor: JobCursor, next: string): void {
    if (cursor.cursor === next) return
    const refused = cursor.save({ cursor: next })
    if (refused) log.warn(`Job cursor ${job} not saved, so the next run reads the same records first: ${refused}`)
}

function recoverEndedAgreements(today: string): void {
    visitNextPage(
        JOB.endedAgreementReturns,
        'x_daas_ham_agreement',
        (agreement) => {
            agreement.addQuery('ends', '<', today)
            agreement.addQuery(END_RETURN_RAISED, false)
            agreement.addNotNullQuery('ends')
        },
        recoverEquipment,
    )
}

/** Raise the Returns of an ended Agreement and mark it. False when it is left for a later run: a Return or the mark was refused. */
function recoverEquipment(agreement: GlideRecord): boolean {
    const agreementId = agreement.getUniqueValue()
    const recover = `Agreement ${str(agreement, 'number')} ended ${str(agreement, 'ends')}: recover all equipment`
    // One Return per Site, each a field de-install with its own change and work order there. Units still shipped
    // there go too (domain/returns `stagesTakenBack`): once all are raised, the job leaves this Agreement.
    const bySite = installedAssetIdsBySite({ agreementId, stages: stagesTakenBack('agreement_end') })
    // The Returns this end raised: after the end date, so not those of an end before a renewal.
    const raisedForEnd = `trigger=${RETURN_TRIGGER.agreement_end}^agreement=${agreementId}^sys_created_on>=${str(agreement, 'ends')} 00:00:00`
    let refused = false
    for (const [siteId, assetIds] of bySite) {
        // Raised once per Site: a run sent round again (another Site's Return or the mark below refused) finds the
        // units that Return could not take (logged then) still there, and would raise an empty Return each day.
        if (exists(RETURN, `${raisedForEnd}^site=${siteId}`)) continue
        const site = findById('cmn_location', siteId)
        const raised = raiseReturn({
            trigger: 'agreement_end',
            customerId: str(agreement, 'customer'),
            siteId,
            agreementId,
            method: 'fsm_deinstall',
            assetIds,
            description: site ? `${recover} from ${str(site, 'name')}` : recover,
        })
        if (!raised) refused = true
    }
    // A refused Return is raised on a later run. Units put on a Return now are pending return, so not found again.
    if (refused) return false
    agreement.setValue(END_RETURN_RAISED, true)
    if (agreement.update()) return true
    // Refused, a later run finds the Agreement again, raises no Return twice (above) and saves the mark again.
    warnRefused(agreement, `Agreement ${str(agreement, 'number')} not marked as its end Returns raised`)
    return false
}

function returnTemporaryDeployments(today: string): void {
    const horizon = addDays(today, intProperty(PROPERTY.temporaryReturnLeadDays))
    const temporary: OrderType = 'temporary'
    visitNextPage(
        JOB.temporaryOrderReturns,
        'x_daas_ham_order',
        (order) => {
            order.addQuery('order_type', temporary)
            order.addQuery('return_raised', false)
            order.addNotNullQuery('end_date')
            order.addQuery('end_date', '<=', horizon)
            order.addQuery('stage', 'IN', TEMPORARY_RETURN_STAGES.join(','))
        },
        (order) => returnDeployment(order, today),
    )
}

/**
 * Raise the Return of a temporary Order that ends and mark it. False when it is left for a later run: it is still
 * being installed, or its Return or the mark was refused.
 */
function returnDeployment(order: GlideRecord, today: string): boolean {
    const orderId = order.getUniqueValue()
    const assetIds = installedAssetIds({ orderId, stages: stagesTakenBack('temporary_end') })
    // The Return is raised once, so an Order still being installed waits until every unit is installed. Once its
    // end date has passed, the units still shipped come back too.
    const installing = str(order, 'stage') === ORDER_STAGE.installing && str(order, 'end_date') >= today
    if (installing && (assetIds.length === 0 || installedAssetIds({ orderId }).length < assetIds.length)) return false
    // Raised once: a run whose mark below was refused left the units that Return could not take (logged then).
    const raisedBefore = () => exists(RETURN, `trigger=${RETURN_TRIGGER.temporary_end}^source_order=${orderId}`)
    if (assetIds.length > 0 && !raisedBefore()) {
        const raised = raiseReturn({
            trigger: 'temporary_end',
            customerId: str(order, 'customer'),
            siteId: str(order, 'site'),
            agreementId: str(order, 'agreement'),
            method: collectionMethod(str(order, 'install_mode') as InstallMode | ''),
            assetIds,
            sourceOrderId: orderId,
            description: `Temporary deployment ${str(order, 'number')} ends ${str(order, 'end_date')}`,
        })
        if (!raised) return false
    }
    order.setValue('return_raised', true)
    if (order.update()) return true
    // Refused, a later run finds the Order again, raises no second Return (above) and saves the mark again.
    warnRefused(order, `Temporary Order ${str(order, 'number')} not marked as its Return raised`)
    return false
}
```

Notes on what changed, for your own check of the result:

- The two queries have the same conditions as before, added by the same `addQuery` calls. The
  Orders are no longer ordered by `end_date`: both kinds are read in sys_id order.
- Each `continue` of the old loops is now `return false`. A mark that is saved returns `true`, and
  a mark that is refused now also counts as left for a later run.
- The position is saved after the page is handled. When the page was full, it is the last record
  read. When it was not, the end was reached and the position is cleared.
- The warning is logged only when a full page was read and every record of it was left.

**Verify**:

- `npx vitest run src/server/platform/scheduled-returns.test.ts src/server/domain/chunked-job.test.ts`
  → 54 passed, 0 failed (7 and 47).
- `grep -c "setLimit(50)" src/server/platform/scheduled-returns.ts` → `0`.
- `grep -c "visitNextPage(" src/server/platform/scheduled-returns.ts` → `3` (its definition and
  two calls).
- `npm run typecheck` → exit 0. `npm run lint` → exit 0.

### Step 5: Document the cursors

In `src/server/platform/job-cursor.ts`, insert this line in the doc comment at the top of the
file, directly after the `JOB.oemClaimStranded` line (line 13):

```ts
 * - `JOB.endedAgreementReturns`, `JOB.temporaryOrderReturns` (platform/scheduled-returns): the last record a run read, '' once it read them all;
```

In `docs/adr/0007-chunked-jobs-with-persistent-cursors.md`, replace the three lines of the
*Scheduled returns* bullet (quoted under "What ADR 0007 says", lines 44 to 46) with:

```md
- Scheduled returns (`platform/scheduled-returns.ts` `raiseDueReturns`) take a limited number of ended
  Agreements and of ending temporary Orders a run (`PAGE` in that module), each in sys_id order
  from where the last run stopped (the `x_daas_ham_job_cursor` rows `ended_agreement_returns` and
  `temporary_order_returns`, which hold only that position), starting over after the last. Each
  one raised is flagged and drops out. One left for a later run (a Return or its mark refused, an
  Order still being installed) stays, and no longer keeps those after it from being read; a run
  that leaves every record it read logs a warning.
```

In `docs/spec/p2-aftersales.md`, insert this bullet directly before the bullet that starts
`- Through the record producer, a return is raised only when the Return create rule lets its requester`,
keeping the blank line between the table and the bullets:

```md
- The daily job reads at most 50 ended Agreements and 50 ending temporary Orders a run, each in
  sys_id order from where the last run stopped, and starts over after the last (ADR 0007). One it
  leaves for a later run (a Return or its mark refused, an Order still being installed) does not
  keep those after it from being read. A run that leaves every record it read logs a warning.
```

In `docs/verify-on-instance.md`, replace the last two of the four lines quoted under
"Documentation to change" (lines 204 and 205) with:

```md
billing pass (ADR 0007), `provider_tag_sequence` the Provider tag counter, `oem_claim_stranded`
only where the OEM claim run's check for stranded steps goes on from, and
`ended_agreement_returns` and `temporary_order_returns` only where the daily job that raises
agreement-end and temporary-end returns reads on from, each with no status.
```

**Verify**:

- `grep -c "JOB.endedAgreementReturns" src/server/platform/job-cursor.ts` → `1`.
- `grep -c "temporary_order_returns" docs/adr/0007-chunked-jobs-with-persistent-cursors.md docs/verify-on-instance.md`
  prints `1` for each file.
- `grep -c "the limits are in that module" docs/adr/0007-chunked-jobs-with-persistent-cursors.md` → `0`.
- `grep -c "The daily job reads at most 50 ended Agreements" docs/spec/p2-aftersales.md` → `1`.

### Step 6: Run the full gate and commit

```sh
npm run check
git status --short
```

**Verify**: `npm run check` exits 0 (1807 tests passed at the planned-at commit, 3 more than
before; more if other plans landed). `git status --short` lists only the seven in-scope files. If
`src/fluent/generated/keys.ts` shows as modified, see the STOP conditions.

Commit the seven files in one commit, with the subject from "Git workflow" and a body that says
what was wrong and why.

## Test plan

- `src/server/platform/scheduled-returns.test.ts` (3 tests added, in the style of the tests
  already in the file and reusing its `unit`, `rows` and `returned` helpers):
  - 50 temporary Orders still being installed plus one due behind them: the first run raises
    nothing, keeps its position and warns, and the second run raises the due Order's Return. This
    is the regression test for the finding;
  - 50 ended Agreements whose Return is refused plus one behind them: the same, for Agreements;
  - a stored position after the last record: the run starts over, handles what is there and
    clears the position.
- The 4 existing tests stay unchanged and must pass. They hold what the job does with one Order.
- `src/server/domain/chunked-job.test.ts` is unchanged. Its `JOB` test holds that the two new
  names are no duplicates.
- Verification: `npx vitest run src/server/platform/scheduled-returns.test.ts src/server/domain/chunked-job.test.ts`
  → 54 passed, 0 failed.

What the tests cannot show: the fake sorts sys_ids as strings, as the platform does, but its ids
are short names, not 32-character sys_ids. The paging rests on the same `sys_id>` condition and
`orderBy('sys_id')` that `visitPage` in `chunked.ts` already uses on an instance.

ATF and instance checks: ATF runs on an instance only, and no ATF test covers this job with more
than 50 records. On an instance, after one run of the job, *Job cursor* shows the rows
`ended_agreement_returns` and `temporary_order_returns` with an empty *Cursor*. That check is
optional for handing the work back. Say in your report whether it was run.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] The test command in the test plan reports 54 passed, 0 failed
- [ ] `npm run check` exits 0
- [ ] `grep -c "setLimit(50)" src/server/platform/scheduled-returns.ts` prints `0`
- [ ] `grep -c "orderBy('end_date')" src/server/platform/scheduled-returns.ts` prints `0`
- [ ] `grep -c "endedAgreementReturns\|temporaryOrderReturns" src/server/domain/chunked-job.ts` prints `2`
- [ ] `grep -c "the limits are in that module" docs/adr/0007-chunked-jobs-with-persistent-cursors.md` prints `0`
- [ ] `git diff --stat main..HEAD -- src/fluent` prints nothing
- [ ] `git status --short` is empty and only the seven in-scope files differ from `main`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts. In particular, if
  `scheduled-returns.ts` differs in any line from the planned-at commit, do not paste the file of
  step 4 over it: another change would be lost.
- `JOB` already has a row for scheduled returns, or the job already reads from a cursor.
- `raiseDueReturns` has gained a run lock or a parameter. The scheduled script calls it with no
  arguments.
- Step 3 gives a different set of failing tests than the three listed.
- A test fails with a message that starts with `fake Glide:`. Report the message. Do not extend
  `fake-glide.ts` under this plan.
- One of the 4 existing tests fails after step 4. The handling of one Order must not have changed.
- `openJobCursor` or `JobCursor.save` in `job-cursor.ts` no longer has the shape described under
  "What ADR 0007 says, and the precedent to copy".
- `npm run build` leaves `src/fluent/generated/keys.ts` modified. Report the diff.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- A record that waits is read again once per cycle, not once per run. With `n` records waiting, a
  record gets its turn every `n / 50` runs, rounded up. The job runs once a day. If hundreds of
  Agreements or Orders wait at once, raise `PAGE` or run the job more often. The warning added
  here is the sign.
- Temporary Orders are no longer read earliest end date first. See "Why this design" for the
  bound. If the earliest-first order is wanted back above 50 waiting Orders, the cursor has to
  hold an end date and a sys_id together.
- The position is saved after the page is handled. A run that dies in the middle of a page saves
  nothing, and the next run reads the same page again. That is as before for a run that dies.
- The two job-cursor rows hold only a position. Their *Last status* and *Last run* stay empty,
  like `oem_claim_stranded`. Do not read them as a stalled pass.
- A new reason to leave a record for a later run must return `false` from `recoverEquipment` or
  `returnDeployment`, so that the warning counts it.
- A reviewer should check three things: that the conditions of the two queries are the old ones,
  that each old `continue` became `return false`, and that the bodies of `recoverEquipment` and
  `returnDeployment` are otherwise the old loop bodies.
- Plan 028 edits the neighbouring *Attestations* bullet of ADR 0007. The two edits do not overlap,
  but they touch adjacent lines, so the second one to land may need a trivial rebase.
- Deferred: a run lock for this job. Two runs at once (the schedule and an *Execute now*) can
  still both raise a Return for one Site before either has saved it. That race exists today and
  was not part of this finding.
