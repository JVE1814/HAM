# Plan 023: Test the billing pull API, Reset generation and the CSV export on the fake Glide

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- src/server/test-support/fake-glide.ts src/server/test-support/fake-glide.test.ts src/server/test-support/encoded-query.ts src/server/entry/billing.test.ts src/server/entry/billing.ts src/server/platform/billing.ts src/server/domain/billing.ts`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

Finance and the ERP integration read the bill through three paths that no unit test runs today:
the billing pull API (`GET /billing_periods` and `GET /billing_periods/{id}/lines`), the CSV attached
to a closed Billing period, and *Reset generation*, the only way out of a period stuck in
*Generating*. A paging error in the pull API loses or repeats Billing lines in the ERP. A reset that
does not retire its pass lets an old chunk bill beside a *Regenerate*. Two exports at once can leave
two CSV files.

The code is untested because the tests' in-memory stand-in for Glide lacks what it calls:
`GlideRecord#chooseWindow`, the `ORDERBY` terms of an encoded query, and `GlideSysAttachment`. This
plan adds those three to the stand-in, each with its own test, and then tests the three paths
through their entry functions. It changes no behaviour of the app.

## Current state

### The code under test

`src/server/platform/billing.ts` holds the functions. `src/server/entry/billing.ts` wires them to a
REST route, a UI action or a script action.

The lines of a period are read in a fixed order, and a page is a window of them:

```ts
// src/server/platform/billing.ts:632-638
function linesOf(periodId: string): GlideRecord {
    const line = new GlideRecord(LINE)
    line.addQuery('billing_period', periodId)
    line.orderBy('customer')
    line.orderBy('sys_id')
    return line
}
```

```ts
// src/server/platform/billing.ts:689-708
/** One page of a period's lines as the pull API gives it (a closed period's are final), or null for an unknown period. */
export function linesPage(periodId: string, offset: number, limit: number): BillingLinesPage | null {
    const period = findById(PERIOD, periodId)
    if (!period) return null
    const stored = lineReader()
    const line = linesOf(periodId)
    line.chooseWindow(offset, offset + limit, false)
    line.query()
    const lines: BillingLinesPage['lines'] = []
    while (line.next()) lines.push(billingLineJson(line.getUniqueValue(), stored(line)))
    return {
        period: str(period, 'period'),
        status: str(period, 'status'),
        final: str(period, 'status') === BILLING_PERIOD_STATUS.closed,
        totals: totalsOf([periodId]).get(periodId) ?? [],
        offset,
        lines,
        nextOffset: lines.length === limit ? offset + limit : null,
    }
}
```

The routes check the role and bound the page size:

```ts
// src/server/entry/billing.ts:88-104
function canPull(response: RESTAPIResponse): boolean {
    return requireRole(response, [ROLE.finance, ROLE.integration], 'Requires the finance or integration role')
}

export function listBillingPeriods(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!canPull(response)) return
    reply(response, 200, recentPeriods(pullPageSize(queryInt(request, 'limit', PULL_PAGE.periods.size), PULL_PAGE.periods)))
}

export function getBillingLines(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!canPull(response)) return
    const offset = queryInt(request, 'offset', 0)
    const limit = pullPageSize(queryInt(request, 'limit', PULL_PAGE.lines.size), PULL_PAGE.lines)
    const page = linesPage(pathParam(request, 'id'), offset, limit)
    if (!page) return reply(response, 404, { error: 'Unknown billing period' })
    reply(response, 200, page)
}
```

```ts
// src/server/domain/billing.ts:302-309
export const PULL_PAGE = {
    periods: { size: 24, most: 120 },
    lines: { size: 1000, most: 5000 },
} as const

export function pullPageSize(requested: number, page: { most: number }): number {
    return Math.min(Math.max(requested, 1), page.most)
}
```

*Reset generation* retires the pass and then checks that no chunk started meanwhile:

```ts
// src/server/platform/billing.ts:471-493
export function resetGeneration(period: GlideRecord): PeriodOutcome {
    const name = str(period, 'period')
    const job = JOB.billingGenerate(period.getUniqueValue())
    const pass = findJobCursor(job)
    const lastChunk = pass ? pass.lastRun : ''
    const activity = [glideToMs(str(period, 'sys_updated_on')), glideToMs(lastChunk)]
    const decision = decideGenerationReset(str(period, 'status'), activity, nowMs())
    if (!decision.reset) return { done: false, why: `${name} not reset: ${decision.why}` }
    // Without a job cursor no pass was recorded, and chunks of none are dropped: nothing is left to retire.
    if (pass) {
        const refused = retirePass(pass)
        if (refused) return { done: false, why: `${name} not reset: its generation could not be stopped: ${refused}` }
        if ((findJobCursor(job) ?? pass).lastRun !== lastChunk) {
            return {
                done: false,
                why: `${name} not reset: a chunk of its generation started as it was being reset. Its generation is stopped and the period stays Generating until that chunk is done: Reset generation again in ${RESET_AFTER_IDLE_MINUTES} minutes`,
            }
        }
    }
    period.setValue('last_error', resetGenerationError(gs.getUserDisplayName(), decision.idleMinutes))
    // Refused (the platform says why), it stays generating with its pass retired: Reset generation again.
    return holdForReview(period) ? { done: true } : { done: false, refusedSave: true }
}
```

The export writes a file and then keeps the oldest copy:

```ts
// src/server/platform/billing.ts:600-630
export function attachExport(periodId: string): void {
    const period = findById(PERIOD, periodId)
    if (!period) return
    const found = exportState(period)
    if (found.state !== 'missing') return
    const { fileName } = found
    try {
        const rows: Array<Array<string | number>> = [billingCsvHeader()]
        const stored = lineReader()
        const line = linesOf(periodId)
        line.query()
        while (line.next()) rows.push(billingCsvRow(str(period, 'period'), stored(line)))
        new GlideSysAttachment().write(period, fileName, 'text/csv', toCsv(rows))
        keepOldestExport(period, fileName)
    } catch (error) {
        log.error(`CSV export of billing period ${str(period, 'period')} failed: ${messageOf(error)}`)
    }
}

/** Delete every copy of the export but the oldest (a deterministic choice every racing export agrees on). */
function keepOldestExport(period: GlideRecord, fileName: string): void {
    const copy = new GlideRecord('sys_attachment')
    copy.addEncodedQuery(`${exportQuery(period, fileName)}^ORDERBYsys_created_on^ORDERBYsys_id`)
    copy.query()
    const attachments = new GlideSysAttachment()
    if (copy.next()) while (copy.next()) attachments.deleteAttachment(copy.getUniqueValue())
}

function exportQuery(period: GlideRecord, fileName: string): string {
    return `table_name=${PERIOD}^table_sys_id=${period.getUniqueValue()}^file_name=${fileName}`
}
```

The entry functions the tests call are `uiResetBillingGeneration` (`entry/billing.ts:50-53`, admins
only), `uiExportBillingPeriod` (`:59-64`, the *Re-export CSV* button), `exportBillingPeriod`
(`:66-68`, the script action of the `x_daas_ham.billing.export` event), `listBillingPeriods` and
`getBillingLines`.

### What the stand-in lacks

`src/server/test-support/fake-glide.ts` is the one stand-in for `@servicenow/glide`. Its rule, from
its header comment:

```ts
// src/server/test-support/fake-glide.ts:23-24
 * A Glide method the fake does not have fails the test with a TypeError: add it here, once, with the platform's
 * behaviour.
```

Three things are missing.

1. `chooseWindow`. The class has `setLimit` only:

   ```ts
   // src/server/test-support/fake-glide.ts:211-213
   class GlideRecord extends Conditions {
       private ordering: Array<{ field: string; descending: boolean }> = []
       private limit = Infinity
   ```

   ```ts
   // src/server/test-support/fake-glide.ts:235-247
       setLimit(limit: number): void {
           this.limit = limit
       }
       setWorkflow(): void {}

       query(): void {
           const found = this.matching()
           for (const { field, descending } of [...this.ordering].reverse()) {
               found.sort((a, b) => compare(walk(this.table, a, field), walk(this.table, b, field)) * (descending ? -1 : 1))
           }
           this.found = found.slice(0, this.limit)
           this.at = -1
       }
   ```

2. `ORDERBY` in an encoded query. `keepOldestExport` orders with `^ORDERBYsys_created_on^ORDERBYsys_id`.
   The fake hands the whole query to the tests' evaluator, which reads the token `ORDERBY...` as an
   `^OR` term and throws `encoded query: unknown term "DERBYsys_created_on"`
   (`src/server/test-support/encoded-query.ts:85-92` splits on `^`, line 27 is the term pattern).

3. `GlideSysAttachment`. The fake exports no such class:

   ```ts
   // src/server/test-support/fake-glide.ts:455
   export const glide = { GlideRecord, GlideAggregate, GlideDateTime, GlideTableHierarchy, gs }
   ```

### The platform's behaviour to keep

- `chooseWindow(firstRow, lastRow, forceCount)`: `firstRow` is the zero-based first row, inclusive.
  `lastRow` is the zero-based end of the range, exclusive. The ServiceNow GlideRecord reference says
  "if firstRow = 1 and lastRow = 5, four records are returned", and its example
  `orderBy('number'); chooseWindow(2, 4)` returns the third and fourth record. The window applies to
  the ordered result. `forceCount` only forces a row count.
- `setLimit` and `chooseWindow` together: the same reference says "The setLimit() method implicitly
  calls the chooseWindow() method". The one called last decides the rows: `chooseWindow(20, 30)` then
  `setLimit(100)` gives 100 rows from the first, and `setLimit(5)` then `chooseWindow(20, 30)` gives
  rows 20 to 29. Source: https://www.servicenow.com/docs/r/xanadu/api-reference/server-api-reference/c_GlideRecordAPI.html
- `ORDERBY<field>` and `ORDERBYDESC<field>` in an encoded query order the rows, as `orderBy` and
  `orderByDesc` do.
- `GlideSysAttachment#write(record, fileName, contentType, content)` attaches a file to the record
  and returns the sys_id of the new `sys_attachment` row, or null when it was not added.
  `deleteAttachment(sysId)` returns nothing. The row has `table_name`, `table_sys_id`, `file_name`
  and `content_type` (`docs/research/external-contracts.md`, notes "Attachments", N25 to N28).

### The test file to extend

`src/server/entry/billing.test.ts` (258 lines, 10 tests) already drives generation, *Close period*
and *Regenerate* through the entry functions on the fake. Its helpers are reused: `rows`,
`periodRow`, `linesOf`, `period`, `drainGeneration`, `told`, `close`, `regenerate`, `closed`,
`regenerating`, `generate`. Its `beforeEach` sets the clock to `2026-11-11T12:00:00Z` and seeds one
Agreement `ag1` (currency EUR), one site-package Subscription line `sub1` (300 a month, from
2026-08-16) and one open Fee event `fee1` (50, on 2026-09-20). So `generate('2026-09')` writes two
Billing lines: the subscription for 300 and the fee for 50.

Its imports and the `generate` helper today:

```ts
// src/server/entry/billing.test.ts:1-7
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateBillingLines, guardBillingPeriodMonth, uiCloseBillingPeriod, uiRegenerateBillingPeriod } from './billing.ts'
import { generateNewPeriod } from '../platform/billing.ts'
import { waiveOpenFees } from '../platform/fees.ts'
import { EVENT } from '../domain/events.ts'
import { platform, recordOf, type Row } from '../test-support/fake-glide.ts'
import type { GlideRecord } from '@servicenow/glide'
```

```ts
// src/server/entry/billing.test.ts:11-14
const PERIOD = 'x_daas_ham_billing_period'
const LINE = 'x_daas_ham_billing_line'
const FEE = 'x_daas_ham_fee_event'
const SUBSCRIPTION = 'x_daas_ham_subscription_line'
```

```ts
// src/server/entry/billing.test.ts:50-57
/** Create the period of `month` as finance does by hand, and run its generation. */
function generate(month: string): void {
    const created = recordOf<GlideRecord>(PERIOD, { period: month, status: 'generating' }, { fresh: true })
    guardBillingPeriodMonth(created)
    created.insert()
    generateNewPeriod(created)
    drainGeneration()
}
```

How a REST route is called in a test: `src/server/entry/shipping.test.ts:16-30` builds a request and
a response by hand and casts them. The new `pull` helper follows it.

### Conventions that apply (AGENTS.md, README.md "Development")

- A test is a `*.test.ts` file beside its module. A test of `platform/` or `entry/` runs against
  `src/server/test-support/fake-glide.ts`, mocked with
  `vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)`.
  The fake runs no business rule, ACL or flow.
- The fake keeps the platform's behaviour where it is known and throws on what it does not know, so
  no test passes on a guess. A new ability of the fake gets a test in
  `src/server/test-support/fake-glide.test.ts`.
- A relative import in `src/server` names the `.ts` file (`./billing.ts`). ESLint enforces it. The
  one exception in this plan is `fake-glide.test.ts`, which already imports `./fake-glide` without
  it. Leave that line's path as it is.
- Comments only for a non-obvious why. No comment that narrates a test's phases.
- `npx vitest run <path>` needs no build. `npm test` and `npm run check` need `npm run build` first,
  because `src/server/built-metadata.test.ts` fails when a file under `src/server` is newer than
  `dist/app`. `npm run check` builds before it tests.
- `npm run build` rewrites the tracked `src/fluent/generated/keys.ts`. This plan adds no Fluent
  record, so the build must leave that file unchanged.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| The fake's tests | `npx vitest run src/server/test-support` | all pass |
| This plan's tests | `npx vitest run src/server/entry/billing.test.ts src/server/test-support` | all pass |
| Every test of the fake's users | `npx vitest run src/server/platform src/server/entry src/server/test-support` | 0 failed |
| Full gate | `npm run check` | exit 0, all tests pass |

## Scope

**In scope** (the only files you should modify):

- `src/server/test-support/fake-glide.ts`
- `src/server/test-support/fake-glide.test.ts`
- `src/server/entry/billing.test.ts`

**Out of scope** (do NOT touch, even though they look related):

- `src/server/platform/billing.ts`, `src/server/entry/billing.ts`, `src/server/domain/billing.ts`.
  This plan changes no behaviour. If a new test fails, the test or the fake is wrong, or you found a
  bug: see the STOP conditions.
- `src/server/test-support/encoded-query.ts`. The evaluator answers whether one record matches. The
  order of rows belongs to the fake's `GlideRecord`, which is where `ORDERBY` is handled.
- `docs/research/external-contracts.md` and `README.md`. No documented behaviour changes.
- Any `src/fluent` file. `src/fluent/generated/keys.ts` must not change.
- The `nextOffset` of a last page that is full (see "Maintenance notes"). The test pins what the API
  does today. Do not change the API to make it prettier.

## Git workflow

- Branch: `advisor/023-billing-pull-reset-export-tests`, from `main`.
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example
  `Test the billing pull API, Reset generation and the CSV export`. The body says what was untested
  and why (the fake lacked `chooseWindow`, `ORDERBY` and `GlideSysAttachment`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Branch and confirm the baseline

```sh
git checkout main && git checkout -b advisor/023-billing-pull-reset-export-tests
npx vitest run src/server/entry/billing.test.ts src/server/test-support
```

**Verify**: 0 failed. At the planned-at commit: 37 passed in 3 files (10 in
`entry/billing.test.ts`, 14 in `fake-glide.test.ts`, 13 in `encoded-query.test.ts`).

### Step 2: Give the fake `chooseWindow`, `ORDERBY` and `GlideSysAttachment`

Edit `src/server/test-support/fake-glide.ts`. Make these six changes and no other.

(a) In `state()`, directly after the line `properties: {} as Record<string, string>,` (line 79), add:

```ts
        /** The content of each attachment written (GlideSysAttachment#write), by the sys_id of its sys_attachment row. */
        attachments: {} as Record<string, string>,
```

(b) In `class GlideRecord`, replace the line `    private limit = Infinity` (line 213) with:

```ts
    /** The rows of the ordered result a query gives: from `first` up to, not including, `last`. */
    private window = { first: 0, last: Infinity }
```

(c) Replace the `setLimit` method (lines 235-237) with these three methods:

```ts
    /** The platform's setLimit is chooseWindow(0, limit): whichever of the two is called last decides the rows. */
    setLimit(limit: number): void {
        this.window = { first: 0, last: limit }
    }
    /** Rows `first` up to, not including, `last` of the ordered result; forceCount changes no row. */
    chooseWindow(first: number, last: number, _forceCount?: boolean): void {
        this.window = { first, last }
    }
    /** An encoded query's `ORDERBY<field>` and `ORDERBYDESC<field>` terms order the rows, as orderBy and orderByDesc do. */
    override addEncodedQuery(query: string): void {
        const conditions: string[] = []
        for (const term of query.split('^')) {
            const order = /^ORDERBY(DESC)?(.+)$/.exec(term)
            if (order) this.ordering.push({ field: order[2] ?? '', descending: order[1] !== undefined })
            else conditions.push(term)
        }
        super.addEncodedQuery(conditions.join('^'))
    }
```

(d) In `query()`, replace the line `        this.found = found.slice(0, this.limit)` with:

```ts
        this.found = found.slice(this.window.first, this.window.last)
```

(e) Directly above the line `class GlideDateTime {`, add:

```ts
/** Attachments are rows of sys_attachment, saved like any other; their content is kept in `platform.attachments`. */
class GlideSysAttachment {
    write(record: GlideRecord, fileName: string, contentType: string, content: string): string | null {
        const attachment = new GlideRecord('sys_attachment')
        attachment.initialize()
        attachment.setValue('table_name', record.getTableName())
        attachment.setValue('table_sys_id', record.getUniqueValue())
        attachment.setValue('file_name', fileName)
        attachment.setValue('content_type', contentType)
        const id = attachment.insert()
        if (id) platform.attachments[id] = content
        return id
    }
    deleteAttachment(attachmentId: string): void {
        const attachment = new GlideRecord('sys_attachment')
        if (attachment.get(attachmentId) && attachment.deleteRecord()) delete platform.attachments[attachmentId]
    }
}

```

(f) Replace the `glide` export (line 455) with:

```ts
export const glide = { GlideRecord, GlideAggregate, GlideDateTime, GlideSysAttachment, GlideTableHierarchy, gs }
```

Why the attachment is an ordinary row: `exportState` and `keepOldestExport` read `sys_attachment`
with a `GlideRecord`, so the stand-in must store what they query. Going through `insert()` also
gives the row its `sys_id` and `sys_created_on`, and lets a test refuse it with `platform.refuses`.

**Verify**: `npm run typecheck` → exit 0. Then
`npx vitest run src/server/platform src/server/entry src/server/test-support` → 0 failed. No
existing test may fail: `setLimit` behaves as before for every caller that does not also call
`chooseWindow`, and no existing query uses `ORDERBY`.

### Step 3: Test the three new abilities of the fake

Edit `src/server/test-support/fake-glide.test.ts`.

Replace line 4 with:

```ts
const { GlideRecord, GlideAggregate, GlideDateTime, GlideSysAttachment, gs } = glide
```

In `describe('reading', ...)`, insert these two tests directly above the test
`it('fails the test on an operator, a reference or a ^NQ combination it does not know', ...)`:

```ts
    it('gives the rows of a window of the ordered result, the later of chooseWindow and setLimit deciding which', () => {
        const line = new GlideRecord(LINES)
        line.orderBy('sys_id')
        line.chooseWindow(1, 3, false)
        expect(idsOf(line)).toEqual(['l2', 'l3'])
        line.chooseWindow(3, 9, false)
        expect(idsOf(line)).toEqual(['l4'])
        line.chooseWindow(4, 6, false)
        expect(idsOf(line)).toEqual([])
        line.setLimit(1)
        expect(idsOf(line)).toEqual(['l1'])
        line.chooseWindow(2, 4, false)
        expect(idsOf(line)).toEqual(['l3', 'l4'])
    })

    it('orders by the ORDERBY terms of an encoded query, as by orderBy and orderByDesc', () => {
        const line = new GlideRecord(LINES)
        line.addEncodedQuery('orderISNOTEMPTY^ORDERBYDESCline_stage^ORDERBYquantity')
        expect(idsOf(line)).toEqual(['l1', 'l3', 'l2'])
    })

```

In `describe('the rest of the instance', ...)`, insert this test directly above the test
`it('queues events, logs and reads the clock, the user and the properties the test set', ...)`:

```ts
    it('attaches a file to a record as a sys_attachment row, keeps its content and deletes it by sys_id', () => {
        const attachments = new GlideSysAttachment()
        const id = attachments.write(find(ORDERS, 'o1'), 'order.csv', 'text/csv', 'a,b\r\n') ?? ''
        expect(platform.tables.sys_attachment).toEqual([
            expect.objectContaining({ sys_id: id, table_name: ORDERS, table_sys_id: 'o1', file_name: 'order.csv', content_type: 'text/csv' }),
        ])
        expect(platform.attachments).toEqual({ [id]: 'a,b\r\n' })

        platform.refuses = (table) => (table === 'sys_attachment' ? 'no attachment' : '')
        expect(attachments.write(find(ORDERS, 'o2'), 'order.csv', 'text/csv', '')).toBeNull()
        platform.refuses = () => ''

        attachments.deleteAttachment(id)
        expect(platform.tables.sys_attachment).toEqual([])
        expect(platform.attachments).toEqual({})
    })

```

**Verify**: `npx vitest run src/server/test-support` → 30 passed (17 in `fake-glide.test.ts`, 13 in
`encoded-query.test.ts`).

### Step 4: Add the helpers to the billing entry test

Edit `src/server/entry/billing.test.ts`.

Replace its first seven lines (the imports quoted in "Current state") with:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    exportBillingPeriod,
    generateBillingLines,
    getBillingLines,
    guardBillingPeriodMonth,
    listBillingPeriods,
    uiCloseBillingPeriod,
    uiExportBillingPeriod,
    uiRegenerateBillingPeriod,
    uiResetBillingGeneration,
} from './billing.ts'
import { generateNewPeriod, type BillingLinesPage } from '../platform/billing.ts'
import { waiveOpenFees } from '../platform/fees.ts'
import { PULL_PAGE } from '../domain/billing.ts'
import { EVENT } from '../domain/events.ts'
import { ROLE } from '../domain/roles.ts'
import { platform, recordOf, type Row } from '../test-support/fake-glide.ts'
import type { GlideRecord } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
```

Directly after the line `const SUBSCRIPTION = 'x_daas_ham_subscription_line'`, add:

```ts
const CURSOR = 'x_daas_ham_job_cursor'
const ATTACHMENT = 'sys_attachment'
```

Replace the `generate` helper with its doc comment (the eight lines quoted in "Current state") with:

```ts
/** Create the period of `month` as finance does by hand: its first generation chunk is queued, not run. */
function create(month: string): void {
    const created = recordOf<GlideRecord>(PERIOD, { period: month, status: 'generating' }, { fresh: true })
    guardBillingPeriodMonth(created)
    created.insert()
    generateNewPeriod(created)
}

/** Create the period of `month` as finance does by hand, and run its generation. */
function generate(month: string): void {
    create(month)
    drainGeneration()
}

/** Run each CSV export queued, as its script action does; every other event is dropped. */
function drainExport(): void {
    for (let event = platform.events.shift(); event; event = platform.events.shift()) {
        if (event.name === EVENT.billingExport) exportBillingPeriod(recordOf('sysevent', { name: event.name, parm1: event.parm1 }))
    }
}

/** Call a route of the pull API as the platform does, each query parameter an array, for a user holding `roles`. */
function pull(
    route: (request: RESTAPIRequest, response: RESTAPIResponse) => void,
    sent: { id?: string; query?: Record<string, string> } = {},
    roles: string[] = [ROLE.integration],
): { status: number; body: unknown } {
    platform.user = { ...platform.user, roles }
    const reply = { status: 0, body: null as unknown }
    const queryParams = Object.fromEntries(Object.entries(sent.query ?? {}).map(([name, value]) => [name, [value]]))
    const request = { pathParams: { id: sent.id }, queryParams } as unknown as RESTAPIRequest
    const response = {
        setStatus: (status: number) => void (reply.status = status),
        setBody: (body: unknown) => void (reply.body = body),
    } as unknown as RESTAPIResponse
    route(request, response)
    return reply
}
```

`create` is `generate` without the drain: the first generation chunk stays queued, which is the
state *Reset generation* acts on. `generate` keeps its behaviour, so the ten existing tests are
unaffected.

**Verify**: `npx vitest run src/server/entry/billing.test.ts` → 10 passed. (`npm run lint` would
report the unused imports and helpers at this point. That is expected until step 5.)

### Step 5: Add the tests

Append this block to the end of `src/server/entry/billing.test.ts`, after one blank line:

```ts
describe('the billing pull API', () => {
    const line = (sysId: string, customer: string, amount: string, currency = 'EUR'): Row => ({
        sys_id: sysId,
        billing_period: 'p9',
        kind: 'subscription',
        customer,
        agreement: 'ag1',
        subscription_line: 'sub1',
        site: 'site1',
        description: 'Site package',
        units: '30',
        monthly_rate: '300',
        amount,
        currency,
    })
    const page = (query: Record<string, string>) => pull(getBillingLines, { id: 'p9', query }).body as BillingLinesPage
    const ids = (lines: BillingLinesPage['lines']) => lines.map((sent) => sent.id)

    beforeEach(() => {
        platform.tables[PERIOD] = [
            { sys_id: 'p8', period: '2026-08', status: 'closed', line_count: '0' },
            { sys_id: 'p9', period: '2026-09', status: 'closed', line_count: '5' },
        ]
        // Stored in no order: a page is cut from the lines by customer, then by sys_id.
        platform.tables[LINE] = [
            line('l2', 'initech', '10', 'USD'),
            line('l4', 'globex', '40'),
            line('l3', 'acme', '100'),
            line('l1', 'globex', '30'),
            line('l5', 'acme', '200'),
        ]
    })

    it('lists the most recent periods, newest first, each with its totals per currency', () => {
        expect(pull(listBillingPeriods)).toEqual({
            status: 200,
            body: {
                periods: [
                    {
                        id: 'p9',
                        period: '2026-09',
                        status: 'closed',
                        lines: 5,
                        totals: [
                            { currency: 'EUR', lines: 4, amount: 370 },
                            { currency: 'USD', lines: 1, amount: 10 },
                        ],
                    },
                    { id: 'p8', period: '2026-08', status: 'closed', lines: 0, totals: [] },
                ],
            },
        })
        expect((pull(listBillingPeriods, { query: { limit: '1' } }).body as { periods: Array<{ id: string }> }).periods.map((period) => period.id)).toEqual(['p9'])
    })

    it("pages a period's lines by customer: two full pages, then the rest and no next page", () => {
        const first = page({ limit: '2' })
        expect(first).toMatchObject({ period: '2026-09', status: 'closed', final: true, offset: 0, nextOffset: 2 })
        expect(first.totals).toEqual([
            { currency: 'EUR', lines: 4, amount: 370 },
            { currency: 'USD', lines: 1, amount: 10 },
        ])
        expect(ids(first.lines)).toEqual(['l3', 'l5'])
        expect(first.lines[0]).toEqual({
            id: 'l3',
            kind: 'subscription',
            customerId: 'acme',
            customer: 'acme',
            agreement: 'ag1',
            subscriptionLine: 'sub1',
            siteId: 'site1',
            site: 'site1',
            feeEvent: '',
            description: 'Site package',
            units: 30,
            monthlyRate: 300,
            amount: 100,
            currency: 'EUR',
        })

        const second = page({ limit: '2', offset: '2' })
        expect([ids(second.lines), second.offset, second.nextOffset]).toEqual([['l1', 'l4'], 2, 4])

        const last = page({ limit: '2', offset: '4' })
        expect([ids(last.lines), last.offset, last.nextOffset]).toEqual([['l2'], 4, null])
    })

    it('follows a last page that is full with an empty one, which names no next page', () => {
        rows(LINE).pop()
        expect(page({ limit: '2', offset: '2' }).nextOffset).toBe(4)
        expect(page({ limit: '2', offset: '4' })).toMatchObject({ lines: [], nextOffset: null })
    })

    it("gives every line by default, one for a limit of 0 and no more than the page's most", () => {
        expect(ids(page({}).lines)).toEqual(['l3', 'l5', 'l1', 'l4', 'l2'])
        expect(ids(page({ limit: '0' }).lines)).toEqual(['l3'])

        const most = PULL_PAGE.lines.most
        platform.tables[LINE] = Array.from({ length: most + 1 }, (_, at) => line(`l${String(at).padStart(5, '0')}`, 'acme', '1'))
        const capped = page({ limit: String(most * 2) })
        expect([capped.lines.length, capped.nextOffset]).toEqual([most, most])
    })

    it('says a period still open is not final', () => {
        Object.assign(periodRow('2026-09') ?? {}, { status: 'ready' })
        expect(page({})).toMatchObject({ status: 'ready', final: false })
    })

    it('answers 404 for a period it does not know, and 403 without the finance or integration role', () => {
        expect(pull(getBillingLines, { id: 'nosuch' })).toEqual({ status: 404, body: { error: 'Unknown billing period' } })
        const refused = { status: 403, body: { error: 'Requires the finance or integration role' } }
        expect(pull(getBillingLines, { id: 'p9' }, [ROLE.assetManager])).toEqual(refused)
        expect(pull(listBillingPeriods, {}, [])).toEqual(refused)
        expect(pull(listBillingPeriods, {}, [ROLE.finance]).status).toBe(200)
    })
})

describe('Reset generation', () => {
    const MINUTE = 60000
    const reset = (current: GlideRecord) => told(uiResetBillingGeneration, current)
    const cursor = (): Row | undefined => rows(CURSOR)[0]

    beforeEach(() => {
        platform.user = { ...platform.user, name: 'Ada Admin', roles: [ROLE.admin] }
    })

    it('is refused while the generation showed activity in the last 30 minutes, which then finishes', () => {
        create('2026-09')
        platform.clock += 29 * MINUTE

        expect(reset(period('2026-09'))).toEqual([
            'error 2026-09 not reset: its generation was active 29 minute(s) ago and may still be running; it can be reset once it has shown no activity for 30 minutes',
        ])
        expect(periodRow('2026-09')?.status).toBe('generating')

        drainGeneration()
        expect(periodRow('2026-09')).toMatchObject({ status: 'ready', line_count: '2' })
    })

    it('holds an idle generation for review and retires its pass: Close refuses until a Regenerate, which bills each line once', () => {
        create('2026-09')
        platform.clock += 30 * MINUTE

        expect(reset(period('2026-09'))).toEqual(['info 2026-09 is ready for review, reset by hand: Regenerate it before closing'])
        expect(periodRow('2026-09')).toMatchObject({
            status: 'ready',
            line_count: '0',
            last_error: 'Generation reset by hand by Ada Admin after 30 minutes without activity; its lines may be incomplete: Regenerate before closing',
        })
        expect(cursor()).toMatchObject({ cursor: '', last_status: 'reset by hand' })
        expect(close(period('2026-09'))).toEqual([expect.stringMatching(/^error 2026-09 did not generate cleanly/)])

        // The chunk the reset pass had queued is still in the queue, ahead of the Regenerate's.
        expect(regenerate(period('2026-09'))).toEqual(regenerating('2026-09'))
        drainGeneration()
        expect(platform.warnings).toEqual([expect.stringContaining('dropped a generation chunk of a pass reset or replaced')])
        expect(linesOf('2026-09').map((line) => line.amount)).toEqual(['300', '50'])
        expect(close(period('2026-09'))).toEqual(closed('2026-09'))
    })

    it('leaves the period generating when a chunk of its pass starts as the pass is retired', () => {
        create('2026-09')
        platform.clock += 30 * MINUTE
        platform.onSave = (table, row) => {
            // A chunk records its activity on the job cursor while the Reset saves the cursor without its pass.
            if (table === CURSOR && row.cursor === '') Object.assign(cursor() ?? {}, { last_run: '2026-11-11 12:30:00' })
        }

        expect(reset(period('2026-09'))).toEqual([
            'error 2026-09 not reset: a chunk of its generation started as it was being reset. Its generation is stopped and the period stays Generating until that chunk is done: Reset generation again in 30 minutes',
        ])
        expect(periodRow('2026-09')?.status).toBe('generating')
        expect(cursor()?.cursor).toBe('')
    })

    it('resets only a period still generating, and only for an admin', () => {
        generate('2026-09')
        platform.clock += 30 * MINUTE
        expect(reset(period('2026-09'))).toEqual(['error 2026-09 not reset: only a period still generating can be reset'])

        platform.user = { ...platform.user, roles: [ROLE.finance] }
        expect(reset(period('2026-09'))).toEqual(['error Only an admin can reset a generation'])
        expect(periodRow('2026-09')?.status).toBe('ready')
    })
})

describe('the CSV export of a closed period', () => {
    const FILE = 'billing-2026-09.csv'
    const reexport = (current: GlideRecord) => told(uiExportBillingPeriod, current)
    const contents = () => rows(ATTACHMENT).map((attachment) => platform.attachments[attachment.sys_id ?? ''])
    const CSV =
        'period,kind,customer,agreement,subscription_line,site,description,units,monthly_rate,amount,currency\r\n' +
        '2026-09,subscription,acme,ag1,sub1,,Site package,30,300,300,EUR\r\n' +
        '2026-09,fee,acme,ag1,,,lost fee: a1 (2026-09-20),1,0,50,EUR\r\n'

    beforeEach(() => {
        generate('2026-09')
        expect(close(period('2026-09'))).toEqual(closed('2026-09'))
    })

    it('is attached to the period once, with a row for each of its lines', () => {
        drainExport()
        expect(rows(ATTACHMENT)).toEqual([
            expect.objectContaining({ table_name: PERIOD, table_sys_id: periodRow('2026-09')?.sys_id, file_name: FILE, content_type: 'text/csv' }),
        ])
        expect(contents()).toEqual([CSV])

        exportBillingPeriod(recordOf('sysevent', { parm1: periodRow('2026-09')?.sys_id ?? '' }))
        expect(rows(ATTACHMENT)).toHaveLength(1)
    })

    it('keeps one copy when two exports of the period run at once', () => {
        let raced = false
        platform.onSave = (table) => {
            if (table !== ATTACHMENT || raced) return
            raced = true
            // A second export finds no file yet while the first one writes its own.
            exportBillingPeriod(recordOf('sysevent', { parm1: periodRow('2026-09')?.sys_id ?? '' }))
        }

        drainExport()

        expect(raced).toBe(true)
        expect(contents()).toEqual([CSV])
    })

    it('is not attached to a period that is not closed', () => {
        Object.assign(periodRow('2026-09') ?? {}, { status: 'ready' })
        drainExport()
        expect(rows(ATTACHMENT)).toEqual([])
        expect(reexport(period('2026-09'))).toEqual(['error Only a closed period can be exported'])
    })

    it('is attached again by Re-export CSV only once the file is gone', () => {
        drainExport()
        expect(reexport(period('2026-09'))).toEqual([`info ${FILE} is already attached; delete it to export again`])
        expect(platform.events).toEqual([])

        platform.tables[ATTACHMENT] = []
        expect(reexport(period('2026-09'))).toEqual(['info The CSV export of 2026-09 is being prepared'])
        drainExport()
        expect(rows(ATTACHMENT).map((attachment) => attachment.file_name)).toEqual([FILE])
    })
})
```

Three facts explain values in these tests that are not obvious:

- A `reference` column reads as its display value in the CSV and in the `customer`, `agreement` and
  `site` fields of the JSON. The fake gives the stored value as the display value of a reference the
  test did not declare in `platform.references`. So the CSV shows `acme` and `ag1`.
- The fee line's `monthly_rate` is empty, and a number column that is empty reads as `0`.
- In the test that lets two exports race, `platform.onSave` runs before the first export's row is
  stored. The second export therefore finds no file, writes its own and keeps it. The first then
  finds two copies and deletes the newer one.

**Verify**: `npx vitest run src/server/entry/billing.test.ts` → 24 passed.

### Step 6: Run the full gate and commit

```sh
npm run check
git status --short
```

**Verify**: `npm run check` exits 0 and the test run reports 1821 passed in 113 files (1804 at the
planned-at commit plus 17; more if other plans landed first). `git status --short` lists exactly the
three in-scope files.

Commit the three files in one commit, with the subject from "Git workflow" and a body that says what
was untested and why.

## Test plan

- `src/server/test-support/fake-glide.test.ts`, 3 new tests, in the style of the tests around them:
  - a window of the ordered result, a window past the end, and `setLimit` and `chooseWindow`
    replacing each other;
  - `ORDERBY` and `ORDERBYDESC` terms of an encoded query;
  - an attachment written as a `sys_attachment` row with its content, a refused write that returns
    null, and a delete by sys_id.
- `src/server/entry/billing.test.ts`, 14 new tests in 3 `describe` blocks, modelled on the tests
  already in that file and on the request and response of `src/server/entry/shipping.test.ts`:
  - **the billing pull API** (6): the list of periods, newest first, with totals per currency, and
    its `limit`; five lines read as two full pages and a last page of one, in customer then sys_id
    order, with `nextOffset` 2, 4 and null and one line checked field by field; a last page that is
    full is followed by an empty one; the default page, a `limit` of 0 read as 1, and a `limit`
    above `PULL_PAGE.lines.most` cut to it; `final` false for a period not closed; 404 for an
    unknown period and 403 without the finance or integration role.
  - **Reset generation** (4): refused inside the 30 idle minutes, after which the generation
    finishes; done once idle, with the pass retired, *Close period* refusing and a *Regenerate*
    billing each line once while the old chunk is dropped; refused when a chunk starts as the pass
    is retired, the period left *Generating*; only a period still generating, and only an admin.
  - **the CSV export of a closed period** (4): attached once with the exact CSV text; one copy left
    when two exports run at once; not attached to a period that is not closed; *Re-export CSV*
    refuses while the file is attached and attaches it again once it is gone.
- Verification: `npx vitest run src/server/entry/billing.test.ts src/server/test-support` → 54
  passed (24, 17 and 13).

What the tests cannot show: the fake is single-threaded, so the two exports and the chunk that
starts during a reset are placed with `platform.onSave`, not run in parallel. That
`chooseWindow`, `ORDERBY` and `GlideSysAttachment` behave on an instance as the fake does rests on
the ServiceNow reference quoted above, not on a run. No instance check is needed to hand this work
back.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npx vitest run src/server/entry/billing.test.ts src/server/test-support` reports 0 failed and 54 passed
- [ ] `npm run check` exits 0
- [ ] `grep -c "chooseWindow" src/server/test-support/fake-glide.ts` prints at least `2`
- [ ] `grep -c "^describe('" src/server/entry/billing.test.ts` prints `9` (6 at the planned-at commit plus the 3 new blocks)
- [ ] `git diff --stat main..HEAD -- src/server/platform src/server/domain src/fluent src/server/entry/billing.ts` prints nothing
- [ ] `git status --short` is empty and only the three in-scope files differ from `main`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts.
- An existing test fails after step 2. The change to `setLimit` or `addEncodedQuery` then altered a
  query some test relies on. Report the test and its message. Do not adjust that test.
- A new test fails with a message that starts with `fake Glide:` or `encoded query:` about
  something other than the three abilities this plan adds. Report the message. Do not extend the
  fake further under this plan.
- A new test in step 5 fails and the cause is in `src/server/platform/billing.ts` or
  `src/server/entry/billing.ts` (the app does something else than the test expects). That is a
  finding about the app. Report the test, the expected and the received value. Do not change the
  app and do not weaken the assertion.
- `npm run build` leaves `src/fluent/generated/keys.ts` modified. Report the diff.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The fake now treats `setLimit(n)` as `chooseWindow(0, n)`. A future query that calls both gets
  the rows of the later call, as the platform gives them.
- `ORDERBY` is handled in the fake's `GlideRecord` only. A `GlideAggregate` given an `ORDERBY` term
  still throws `encoded query: unknown term`, which is right until some code needs it.
- The test `follows a last page that is full with an empty one, which names no next page` pins a
  wrinkle: when the number of lines is a multiple of the page size, the last page with lines names a
  `nextOffset`, and the page after it is empty with `nextOffset` null. `docs/spec/p3-billing.md`
  says `nextOffset` is null on the last page. A client that follows `nextOffset` until null reads
  every line once either way. If the API is changed to answer null on a full last page, change this
  test and the spec line together.
- Not covered, and found while writing this plan: `attachExport` ignores the return value of
  `GlideSysAttachment#write`. A write the platform refuses returns null and throws nothing, so no
  error is logged, although the spec says a failed export is logged as an error naming the period.
  That is a behaviour change and belongs in its own plan.
- `docs/research/external-contracts.md` has no row for `GlideRecord#chooseWindow`. Adding one, with
  the reference quoted in "Current state", was left out to keep this plan to tests.
- A reviewer should check three things: that `fake-glide.ts` changed only as steps 2(a) to 2(f)
  say, that no file outside `test-support/` and the one test file changed, and that each new test
  asserts something a caller of the API, an admin or finance can observe.
