# Plan 041: Log a CSV export the platform does not attach, and name no next page after a full last page

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- src/server/platform/billing.ts src/server/entry/billing.test.ts src/server/test-support/fake-glide.ts docs/spec/p3-billing.md docs/research/external-contracts.md`
> This plan lands after earlier plans, so the command prints changes. These
> are expected and are not a mismatch:
>
> - `src/server/entry/billing.test.ts` and `src/server/test-support/fake-glide.ts`:
>   plan 023 (required, see "Depends on"). Plan 024 appends one `describe` to
>   the test file, and plan 026 changes the default role of its `pull` helper.
> - `docs/spec/p3-billing.md`: plans 024, 025, 026 and 035 edit other lines.
> - `docs/research/external-contracts.md`: plans 032 and 037 edit other lines.
>
> `src/server/platform/billing.ts` is edited by no earlier plan. If it is
> listed, compare it with the excerpts in "Current state". Only a mismatch in
> an excerpt this plan quotes is a STOP condition. This plan anchors its edits
> on text, not on line numbers.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/023-billing-pull-reset-export-tests.md (its tests of the pull API and the export, and its `GlideSysAttachment` and `chooseWindow` on the fake Glide)
- **Category**: bug
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

Finance and the ERP integration read a closed Billing period through two paths, and each has a
small defect in `src/server/platform/billing.ts`.

The CSV export calls `GlideSysAttachment#write` and ignores what it returns. The platform reports a
file it did not attach by returning no sys_id, and it throws nothing. So such an export fails in
silence: no file, and no line in the log, although the spec says a failed export is logged as an
error naming the period.

The pull API answers a page of lines with `nextOffset`, which the spec and the README say is null
on the last page. When the number of lines is a multiple of the page size, the last page is full
and still names a next page, and that page is empty. A client that reads `nextOffset` as "more
lines exist" makes one request too many, or takes the period as incomplete.

After this plan, a write that returns no sys_id is logged as the failed export it is, and a last
page names no next page, full or not.

## Current state

### The export ignores the result of the write

```ts
// src/server/platform/billing.ts:595-617
/**
 * Attach the CSV of a closed period's lines unless it is already attached. Only reads the period, so the
 * closed-period lock is not hit. Two exports racing each other converge on one file: each keeps only the oldest copy.
 * A failure is logged as an error naming the period, and Re-export CSV can be used once it is fixed.
 */
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
```

What the platform returns, as the repo records it:

```md
<!-- docs/research/external-contracts.md:844-846 -->
- **Attachments.** `write(GlideRecord record, String fileName, String contentType, String content)`
  "Attaches a specified attachment to the specified record" and returns the sys_id, or null if not
  added (the app ignores the return value). `deleteAttachment(String attachmentID)` returns void. The
```

The typings of `@servicenow/glide` 27.0.5 say the same in their comment and declare the return type
as `string` (`node_modules/@servicenow/glide/src/types/GlideSysAttachment.d.ts`, "Returns attachment
sys_id or null if the attachment was not added"). So `if (!write(...))` compiles, and it covers both
null and an empty string. Whether an instance returns null for every refused write (a size limit, a
blocked file type) was not confirmed on an instance. It is the documented behaviour.

A logged line starts with the scope, and the fake Glide records it with its level:

```ts
// src/server/platform/log.ts:8-14
const PREFIX = '[x_daas_ham]'

export const log = {
    info: (message: string): void => gs.info(`${PREFIX} ${message}`),
    warn: (message: string): void => gs.warn(`${PREFIX} ${message}`),
    error: (message: string): void => gs.error(`${PREFIX} ${message}`),
}
```

### A full last page names a next page

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

`limit` is already bounded by the route (`src/server/entry/billing.ts`, `getBillingLines`) with
`pullPageSize`:

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

`chooseWindow(firstRow, lastRow, forceCount)` gives the rows from `firstRow`, inclusive, up to
`lastRow`, exclusive, of the ordered result. `GlideRecord#hasNext()` says whether a row follows the
current one. The app uses both already (`chooseWindow` here, `hasNext` in
`src/server/platform/service-intervals.ts`).

### What the documents say

```md
<!-- docs/spec/p3-billing.md:122-125 -->
  are. Built from the locked lines by the `x_daas_ham.billing.export` event shortly after closing;
  attaching it does not update the period, and a period that already has the file is skipped (delete
  it, then *Re-export CSV*, to rebuild it).
  Racing exports keep only the oldest copy; a failed export is logged as an error naming the period.
```

```md
<!-- docs/spec/p3-billing.md:129-132 -->
  - `GET /api/x_daas_ham/naas/billing_periods/{id}/lines?offset=<n>&limit=<n>` returns one page of
    lines (`PULL_PAGE` in `domain/billing.ts` holds the page sizes and their caps), each with its
    `currency`, and the period's `totals`; `final` is true once the period is
    closed and `nextOffset` is null on the last page.
```

`README.md:250-251` says the same of `nextOffset` ("`nextOffset` null on the last page"). That line
is true once this plan lands and does not change.

### What plan 023 left in the test file and in the fake

Plan 023 added three `describe` blocks to `src/server/entry/billing.test.ts`. This plan changes one
test of the first and adds one test to the third.

The test that pins today's `nextOffset`, in `describe('the billing pull API', ...)`:

```ts
    it('follows a last page that is full with an empty one, which names no next page', () => {
        rows(LINE).pop()
        expect(page({ limit: '2', offset: '2' }).nextOffset).toBe(4)
        expect(page({ limit: '2', offset: '4' })).toMatchObject({ lines: [], nextOffset: null })
    })
```

That `describe` seeds five Billing lines of the period `p9`, read by customer and then by sys_id as
`l3`, `l5`, `l1`, `l4`, `l2`. `rows(LINE).pop()` removes `l5`, which leaves four: `l3`, `l1`, `l4`,
`l2`. Its helpers are `page(query)`, which calls `GET /billing_periods/p9/lines`, and `ids(lines)`.

`describe('the CSV export of a closed period', ...)` has these helpers, and a `beforeEach` that
generates and closes the period 2026-09:

```ts
    const FILE = 'billing-2026-09.csv'
    const reexport = (current: GlideRecord) => told(uiExportBillingPeriod, current)
    const contents = () => rows(ATTACHMENT).map((attachment) => platform.attachments[attachment.sys_id ?? ''])
    const CSV = ...
```

`drainExport()` runs each queued export as its script action does. `ATTACHMENT` is
`'sys_attachment'`.

The fake's `GlideSysAttachment#write` saves a `sys_attachment` row and returns its sys_id, or null
when the insert is refused. A test refuses it with `platform.refuses`:

```ts
// src/server/test-support/fake-glide.ts, as plan 023 writes it
class GlideSysAttachment {
    write(record: GlideRecord, fileName: string, contentType: string, content: string): string | null {
        const attachment = new GlideRecord('sys_attachment')
        ...
        const id = attachment.insert()
        if (id) platform.attachments[id] = content
        return id
    }
```

### Conventions that apply (AGENTS.md, README.md "Development")

- Layers: `src/server/platform/` holds the Glide services and never imports `entry/`. This plan
  adds no import.
- A test is a `*.test.ts` file beside its module. A test of `platform/` or `entry/` runs against
  `src/server/test-support/fake-glide.ts`, which runs no business rule, ACL or flow.
- Comments only for a non-obvious why. No comment that narrates a test's phases.
- `npx vitest run <path>` needs no build. `npm test` and `npm run check` need `npm run build` first,
  because `src/server/built-metadata.test.ts` fails when a file under `src/server` is newer than
  `dist/app`. `npm run check` builds before it tests.
- `npm run build` rewrites the tracked `src/fluent/generated/keys.ts`. This plan adds no Fluent
  record and changes no client file, so the build must leave that file unchanged.
- When documented behaviour changes, the matching spec or research line changes in the same commit.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| This plan's tests | `npx vitest run src/server/entry/billing.test.ts` | all pass |
| Build | `npm run build` | exit 0; rewrites `dist/` |
| Every test | `npx vitest run` (after a build) | 0 failed |
| Full gate | `npm run check` | exit 0, all tests pass |

## Scope

**In scope** (the only files you should modify):

- `src/server/platform/billing.ts` (only `attachExport`, its doc comment, and `linesPage`)
- `src/server/entry/billing.test.ts` (one test changed, one test added)
- `docs/spec/p3-billing.md` (two places in the section "Export")
- `docs/research/external-contracts.md` (one sentence)

**Out of scope** (do NOT touch, even though they look related):

- `src/server/test-support/fake-glide.ts`. It already returns null from a refused `write`.
- `src/server/entry/billing.ts` and `src/server/domain/billing.ts`. The route, `PULL_PAGE` and
  `pullPageSize` stay as they are. The page still holds at most `limit` lines.
- `keepOldestExport`, `exportState` and `requestExport`. A failed export leaves no file, so
  *Re-export CSV* already queues it again.
- `README.md`. Its sentence about `nextOffset` is true after this plan.
- A retry of the export, a field on the period that records the failure, or a message to finance.
  The spec asks for an error in the log. Nothing more is decided here.
- `recentPeriods` (`GET /billing_periods`). It has no paging.
- `plans/023-billing-pull-reset-export-tests.md`. Its maintenance notes describe both defects. Do
  not edit another plan.
- Any `src/fluent` file. `src/fluent/generated/keys.ts` must not change.

## Git workflow

- Branch: `advisor/041-billing-export-and-last-page`, from `main`.
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example
  `Log a refused CSV export and name no page after a full last page`. The body says what was
  wrong and why (a refused `write` returns no sys_id and throws nothing, and a full last page named
  a next page that is empty).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Branch and confirm the baseline

```sh
git checkout main && git checkout -b advisor/041-billing-export-and-last-page
grep -c "follows a last page that is full with an empty one" src/server/entry/billing.test.ts
grep -c "class GlideSysAttachment" src/server/test-support/fake-glide.ts
npx vitest run src/server/entry/billing.test.ts
npm run build && npx vitest run
git status --short
```

**Verify**: both `grep` commands print `1`. If either prints `0`, plan 023 has not landed: STOP.
The first test run reports 0 failed. Write down how many tests passed in
`src/server/entry/billing.test.ts`: the steps below call that number N (24 if only plan 023 landed,
30 if plan 024 landed too). The full run reports 0 failed. Write down its total: the last step
calls it T (1839 in 113 files if plans 023, 024 and 025 landed and no other). `git status --short`
prints nothing.

### Step 2: Write the two failing tests

Edit `src/server/entry/billing.test.ts`.

In `describe('the billing pull API', ...)`, replace the whole test
`it('follows a last page that is full with an empty one, which names no next page', ...)` (the five
lines quoted in "Current state") with:

```ts
    it('names no next page on a last page that is full, and gives an empty page past the end', () => {
        rows(LINE).pop()
        const last = page({ limit: '2', offset: '2' })
        expect([ids(last.lines), last.nextOffset]).toEqual([['l4', 'l2'], null])
        expect(page({ limit: '4' }).nextOffset).toBeNull()
        expect(page({ limit: '2', offset: '4' })).toMatchObject({ lines: [], nextOffset: null })
    })
```

In `describe('the CSV export of a closed period', ...)`, insert this test directly above the test
`it('is not attached to a period that is not closed', () => {`, followed by one blank line:

```ts
    it('logs an error naming the period when the platform refuses the file, and attaches it on a Re-export CSV after that', () => {
        platform.refuses = (table) => (table === ATTACHMENT ? 'no attachment' : '')
        drainExport()
        expect(rows(ATTACHMENT)).toEqual([])
        expect(platform.logs.filter((logged) => logged.startsWith('error '))).toEqual([
            `error [x_daas_ham] CSV export of billing period 2026-09 failed: the platform did not attach ${FILE}`,
        ])

        platform.refuses = () => ''
        expect(reexport(period('2026-09'))).toEqual(['info The CSV export of 2026-09 is being prepared'])
        drainExport()
        expect(contents()).toEqual([CSV])
    })
```

**Verify**: `npx vitest run src/server/entry/billing.test.ts` → `2 failed | N-1 passed`. The two
failures are exactly:

- `the billing pull API > names no next page on a last page that is full, and gives an empty page past the end`
  (it received `4` where `null` was expected);
- `the CSV export of a closed period > logs an error naming the period when the platform refuses the file, and attaches it on a Re-export CSV after that`
  (it received `[]`: nothing was logged).

Those are the two defects. If the set of failures differs, STOP.

### Step 3: Name a next page only when a line follows

In `src/server/platform/billing.ts`, in `linesPage`, replace these four lines:

```ts
    line.chooseWindow(offset, offset + limit, false)
    line.query()
    const lines: BillingLinesPage['lines'] = []
    while (line.next()) lines.push(billingLineJson(line.getUniqueValue(), stored(line)))
```

with:

```ts
    // One row past the page is read, to know whether a page follows: a last page that is full names none.
    line.chooseWindow(offset, offset + limit + 1, false)
    line.query()
    const lines: BillingLinesPage['lines'] = []
    while (lines.length < limit && line.next()) lines.push(billingLineJson(line.getUniqueValue(), stored(line)))
```

In the object the function returns, replace the line

```ts
        nextOffset: lines.length === limit ? offset + limit : null,
```

with:

```ts
        nextOffset: line.hasNext() ? offset + limit : null,
```

The loop stops after `limit` lines without reading the extra row, so `hasNext()` is true exactly
when that row exists. The page still holds at most `limit` lines, and `limit` is at most
`PULL_PAGE.lines.most`. The query reads one row more than that.

**Verify**: `npx vitest run src/server/entry/billing.test.ts` → `1 failed | N passed`. The one
failure is the export test of step 2.

### Step 4: Take a write that returns no sys_id as a failed export

In `src/server/platform/billing.ts`, replace the last line of the doc comment of `attachExport`:

```ts
 * A failure is logged as an error naming the period, and Re-export CSV can be used once it is fixed.
 */
```

with:

```ts
 * A failure is logged as an error naming the period, and Re-export CSV can be used once it is fixed. A write the
 * platform refuses throws nothing and returns no sys_id, so that is taken as a failure too.
 */
```

In `attachExport`, replace everything from the line `    const { fileName } = found` to the end of
the function with:

```ts
    const { fileName } = found
    const failed = (why: string): void => log.error(`CSV export of billing period ${str(period, 'period')} failed: ${why}`)
    try {
        const rows: Array<Array<string | number>> = [billingCsvHeader()]
        const stored = lineReader()
        const line = linesOf(periodId)
        line.query()
        while (line.next()) rows.push(billingCsvRow(str(period, 'period'), stored(line)))
        if (!new GlideSysAttachment().write(period, fileName, 'text/csv', toCsv(rows))) return failed(`the platform did not attach ${fileName}`)
        keepOldestExport(period, fileName)
    } catch (error) {
        failed(messageOf(error))
    }
}
```

Only three lines differ from today: the new `failed` constant, the `write` line, and the body of
the `catch`. A refused write skips `keepOldestExport`: it added no copy, and an export that did add
one keeps the oldest itself.

**Verify**: `npx vitest run src/server/entry/billing.test.ts` → N+1 passed, 0 failed. Then
`npm run typecheck` → exit 0 and `npm run lint` → exit 0.

### Step 5: Change the documents

In `docs/spec/p3-billing.md`, directly after the line

```md
  Racing exports keep only the oldest copy; a failed export is logged as an error naming the period.
```

add these two lines:

```md
  A file the platform does not attach counts as failed: the platform reports that by returning no
  attachment, with no error of its own.
```

In the same file, replace the line

```md
    closed and `nextOffset` is null on the last page.
```

with:

```md
    closed and `nextOffset` is null on the last page, also when that page is full.
```

In `docs/research/external-contracts.md`, replace the line

```md
  added (the app ignores the return value). `deleteAttachment(String attachmentID)` returns void. The
```

with these two lines:

```md
  added (the app logs a CSV export that returns none as failed, `platform/billing.ts`
  `attachExport`). `deleteAttachment(String attachmentID)` returns void. The
```

**Verify**:

- `grep -c "A file the platform does not attach counts as failed" docs/spec/p3-billing.md` → `1`
- `grep -c "also when that page is full" docs/spec/p3-billing.md` → `1`
- `grep -c "the app ignores the return value" docs/research/external-contracts.md` → `0`
- `grep -c "logs a CSV export that returns none as failed" docs/research/external-contracts.md` → `1`

### Step 6: Run the full gate and commit

```sh
npm run check
git status --short
```

**Verify**: `npm run check` exits 0 and the test run reports T+1 passed (one test added, one
changed), in the same number of files as in step 1. `git status --short` lists exactly the four
in-scope files. `src/fluent/generated/keys.ts` is not among them.

Commit the four files in one commit, with the subject from "Git workflow" and a body that says what
was wrong and why.

## Test plan

- `src/server/entry/billing.test.ts`, modelled on the tests plan 023 put around them:
  - changed, in **the billing pull API**: four lines read two to a page give a full last page with
    `nextOffset` null, a single page that holds all four names no next page, and a page past the
    end is empty with `nextOffset` null. This replaces the test that pinned the old answer.
  - new, in **the CSV export of a closed period**: a write the platform refuses leaves no file and
    logs one error that names the period and the file. *Re-export CSV* then queues the export
    again, and it attaches the file once nothing refuses it.
- Unchanged tests that guard the rest of the paging: `pages a period's lines by customer: two full
  pages, then the rest and no next page` (pages that are not the last still name the next one) and
  `gives every line by default, one for a limit of 0 and no more than the page's most` (a page is
  cut to `PULL_PAGE.lines.most` and names the next page when a line follows).
- Verification: `npx vitest run src/server/entry/billing.test.ts` → N+1 passed.

What the tests cannot show: the fake returns null from a refused `write` because the ServiceNow
reference says the platform does. Which refusals an instance reports that way, and whether it logs
anything itself, was not confirmed on an instance. No instance check is needed to hand this work
back. Say in your report that none was run.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npx vitest run src/server/entry/billing.test.ts` reports 0 failed and N+1 passed
- [ ] `npm run check` exits 0 and reports T+1 passed
- [ ] `grep -c "lines.length === limit" src/server/platform/billing.ts` prints `0`
- [ ] `grep -c "offset + limit + 1" src/server/platform/billing.ts` prints `1`
- [ ] `grep -c "the platform did not attach" src/server/platform/billing.ts` prints `1`
- [ ] `grep -c "follows a last page that is full with an empty one" src/server/entry/billing.test.ts` prints `0`
- [ ] The four `grep -c` checks of step 5 print `1`, `1`, `0` and `1`
- [ ] `git diff --stat main..HEAD -- src/fluent src/server/domain src/server/entry/billing.ts src/server/test-support README.md` prints nothing
- [ ] `git status --short` is empty and only the four in-scope files differ from `main`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `attachExport` or `linesPage` in `src/server/platform/billing.ts` does not match the excerpts in
  "Current state".
- Either `grep` of step 1 prints `0`. Plan 023 has not landed, and this plan changes one of its
  tests and uses its stand-in for `GlideSysAttachment`.
- Step 2 gives a different set of failing tests than the two listed.
- A test other than the two of step 2 fails at any step. In particular, if
  `gives every line by default, one for a limit of 0 and no more than the page's most` fails after
  step 3, the page no longer respects `PULL_PAGE.lines.most`. Report the received values.
- A test fails with a message that starts with `fake Glide:`. Report the message. Do not extend
  `fake-glide.ts` under this plan.
- `npm run build` leaves `src/fluent/generated/keys.ts` modified. Report the diff.
- You are tempted to throw from `attachExport`, to retry the write, or to change the shape of the
  page (`BillingLinesPage`). The fix is a log line and the value of one field.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- `linesPage` reads `limit + 1` rows to answer `nextOffset`. A change to how the page is read (a
  count query, a keyset cursor) must keep the rule that the last page names no next page.
- A client that follows `nextOffset` until it is null read every line once before this plan and
  still does. It now makes one request fewer when the line count is a multiple of the page size.
- The export still has no retry. After a failed export the period has no file, the log has the
  error, and *Re-export CSV* on the period queues it again. If finance should see the failure on
  the period itself, that needs a field and is a new decision.
- `docs/research/external-contracts.md` records the null return from the ServiceNow reference and
  the typings. If an instance shows that a refused write throws instead, the `catch` logs it with
  the same prefix, so both paths end in the same error.
- A reviewer should check three things: that the page loop stops at `limit` before it reads the
  extra row, that a refused write skips `keepOldestExport`, and that the logged error names both
  the period and the file.
