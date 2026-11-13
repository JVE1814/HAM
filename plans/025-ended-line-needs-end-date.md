# Plan 025: Refuse a Subscription line set Ended without an End date

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- src/server/domain/billing.ts src/server/domain/billing.test.ts src/server/entry/agreements.ts src/fluent/agreements/logic.now.ts src/fluent/agreements/tables.now.ts src/server/platform/subscriptions.ts src/fluent/generated/keys.ts docs/spec/p3-billing.md docs/verify-on-instance.md`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition. (Plan 024 exports one interface in
> `src/server/domain/billing.ts` and adds a bullet to `docs/spec/p3-billing.md`
> and a section to `docs/verify-on-instance.md`. Other plans add records to
> `src/fluent/generated/keys.ts`. Those alone are not a mismatch: this plan
> anchors its edits on text, not on line numbers.)

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none for code. Lands after plans/024-interval-follows-line-change.md, because both edit `docs/spec/p3-billing.md` and `docs/verify-on-instance.md`.
- **Category**: bug
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

A Subscription line has a *Status* (Pending, Active, Ended) and an optional *End date*. Billing
reads only the dates: a line with no End date is still open. The Status is an editable choice, and
nothing ties the two together. So a line that finance sets to *Ended* without typing an End date
is billed every month from then on: a site package for the whole month, a per-device line for every
device-day of its units. The rest of the app takes the same line as ended: go-live attaches no unit
to it, the workspace list hides it, and the *In service on an ended line* tile counts its units as
no longer billed. The stored record says two things, and the bill follows the one nobody looks at.

After this plan, a Subscription line cannot be saved *Ended* without its End date. A business rule
refuses the save and asks for the date.

## Current state

### Billing goes by the dates

Generation selects every line that is not pending and whose dates overlap the month:

```ts
// src/server/platform/billing.ts:141-144
    return runTriggeredChunk(queued, {
        job,
        table: 'x_daas_ham_subscription_line',
        query: `status!=${SUBSCRIPTION_LINE_STATUS.pending}^${overlapsMonth(bounds)}`,
```

```ts
// src/server/domain/money.ts:23-29
/**
 * An encoded query for records whose date range (end blank = still open) overlaps the month.
 * The ^OR binds to the end-date clause only: start <= last AND (end empty OR end >= first).
 */
export function overlapsMonth(bounds: MonthBounds): string {
    return `start_date<=${bounds.last}^end_dateISEMPTY^ORend_date>=${bounds.first}`
}
```

A site package with no end is billed to the end of the month, and a per-device line with no end
bills its units' intervals in full:

```ts
// src/server/domain/billing.ts:168-172
function unitsBySite(line: SubscriptionLineTerms, bounds: MonthBounds, sources: ChargeSources): Map<string, number> {
    const bySite = new Map<string, number>()
    if (line.lineType === SUBSCRIPTION_LINE_TYPE.site_package) {
        const units = line.start ? activeDays(bounds, line.start, line.end) : 0
        if (units > 0) bySite.set(line.siteId, units)
```

```ts
// src/server/domain/billing.ts:95-100
function withinLine(interval: DayRange, line: Partial<DayRange>): DayRange | null {
    if (!line.start || !interval.start) return null
    const start = interval.start > line.start ? interval.start : line.start
    const end = !line.end || (interval.end && interval.end < line.end) ? interval.end : line.end
    return end !== undefined && end < start ? null : { start, end }
}
```

### The two fields are independent

```ts
// src/fluent/agreements/tables.now.ts:102-109
        start_date: DateColumn({ label: 'Start date', readOnly: true }),
        end_date: DateColumn({ label: 'End date' }),
        status: ChoiceColumn({
            label: 'Status',
            choices: SUBSCRIPTION_LINE_STATUS_CHOICES,
            default: 'pending',
            dropdown: 'dropdown_without_none',
        }),
```

No business rule of the app runs on a save of `x_daas_ham_subscription_line`.
`src/fluent/agreements/logic.now.ts` has three rules, all on `x_daas_ham_agreement`. The only rule
on the line's table is the before-query visibility rule in `src/fluent/shared/visibility.now.ts`.

### What takes the Status as the truth

```ts
// src/server/domain/billing.ts:110
const ON_ENDED_LINE = `x_daas_ham_subscription_line.status=${SUBSCRIPTION_LINE_STATUS.ended}^ORx_daas_ham_subscription_line.end_date<javascript:gs.beginningOfToday()`
```

```ts
// src/server/domain/in-service.ts:50
    const open = lines.filter((l) => l.status !== 'ended' && !(l.end && l.end < asset.liveOn))
```

The app's own ending of a line sets both fields, so it is not affected by this plan:

```ts
// src/server/platform/subscriptions.ts:101-105
    while (line.next()) {
        line.setValue('status', SUBSCRIPTION_LINE_STATUS.ended)
        line.setValue('end_date', todayIso())
        // A site package bills its own dates, and no later unit leaving ends it: logged for finance to end by hand.
        if (!line.update()) warnRefused(line, `Site package "${str(line, 'description')}" not ended`)
```

That is the only place in `src/server` that sets a line *Ended*. No demo data and no ATF test
creates an ended line.

### What the spec says today

```md
<!-- docs/spec/p3-billing.md:26-32 at the planned-at commit (15 lines further down once plan 024 landed) -->
- A **per-device** line is billed per device-day: `monthly rate × device-days ÷ days in month`, one
  billing line per Site. Its Assets' days count only within the line's own start and end date (the
  end date is billed; no end date means still open), and a line without a start date bills nothing.
  A unit still in service after its line ended is not billed past the end date. It is counted on the
  workspace dashboard's *Billing integrity* tab, tile *In service on an ended line* (fleet assets in
  service or on a temporary deployment whose line is set ended or past its end date), and is never
  moved to another line.
- The *Billing integrity* tab counts fleet assets only (ADR 0016): the Provider IT's equipment in use
```

### The decision (already made; do not reopen it)

**The save is refused. No date is filled in, and generation is not changed.**

- Why a rule on the line and not a filter in generation: leaving ended lines without an End date
  out of generation would stop billing them altogether, including the days of the month before the
  line was ended, and the stored record would still say two things. A rule makes the record say
  one thing, and every reader (generation, Margin, the tile, go-live) then agrees.
- Why refuse and not fill in today: the End date is the last day billed. Only whoever ends the line
  knows it. A line set *Ended* on the 12th may have ended on the last day of the month before, and a
  silently filled 12th would bill twelve days too many, with no message at all on a list edit, an
  import or the Table API. A refusal costs one field and is never wrong. The message offers today,
  for the common case.
- Why the rule looks at the state and not at the change: clearing the End date of a line that is
  already *Ended* brings the same record back. The condition is "Status is Ended and End date is
  empty", on insert and update.
- An End date in a month whose Billing period is closed needs no extra guard. A closed period and
  its lines are locked by their own rules (`src/server/platform/closed-period.ts`) and are never
  rebilled. A period still *Ready for review* is put right with *Regenerate*.

### The pattern to copy

A guard on one of the app's own tables is a before rule whose entry function aborts the save with
the reason from a pure domain function:

```ts
// src/fluent/agreements/logic.now.ts:16-25
BusinessRule({
    $id: Now.ID['br_agreement_currency'],
    name: 'NaaS - check the agreement currency',
    table: 'x_daas_ham_agreement',
    when: 'before',
    action: ['insert', 'update'],
    order: 100,
    condition: 'current.currency.changes()',
    script: guardAgreementCurrency,
})
```

```ts
// src/server/entry/agreements.ts:15-21
export function guardAgreementCurrency(current: GlideRecord): void {
    const entered = str(current, 'currency')
    const problem = agreementCurrencyProblem(entered)
    if (problem) return abortWith(current, problem)
    const code = currencyCode(entered)
    if (code && code !== entered) current.setValue('currency', code)
}
```

```ts
// src/server/platform/rule-api.ts:8-12
export function abortWith(current: GlideRecord, why: string | null): void {
    if (!why) return
    gs.addErrorMessage(why)
    current.setAbortAction(true)
}
```

`setAbortAction` works here. The restriction in README.md "Development" ("the platform ignores
`current.setAbortAction` ... called from this scope on such a table") is about tables of another
scope (`alm_hardware`, `wm_order`). `x_daas_ham_subscription_line` is the app's own table, and
`docs/research/external-contracts.md` records that "the rules on `x_daas_ham_*` tables keep it".

The stored choice values come from one list:

```ts
// src/server/domain/vocabulary.ts:343-347
export const SUBSCRIPTION_LINE_STATUS = {
    pending: 'pending',
    active: 'active',
    ended: 'ended',
} as const satisfies Named<SubscriptionLineStatus>
```

`src/server/domain/billing.ts` imports it already (line 5).

### Conventions that apply (AGENTS.md, README.md "Development")

- Layers: `src/server/domain/` is pure (no Glide). `entry/` holds thin adapters and may import
  `domain/` and `platform/`.
- A relative import in `src/server` names the `.ts` file (`../domain/billing.ts`). An import in a
  `.now.ts` file is written without it.
- A `.now.ts` file holds constants, template literals over constants and imports of constants. No
  function call, loop or spread. The condition below is a template literal over
  `SUBSCRIPTION_LINE_STATUS.ended`, as `src/fluent/billing/logic.now.ts:83` is over
  `BILLING_PERIOD_STATUS.ready`.
- A new Fluent record takes `$id: Now.ID['<name>']` and goes to the feature whose table it serves:
  the line's table is declared in `src/fluent/agreements/`, so the rule goes in
  `src/fluent/agreements/logic.now.ts`.
- The name of a business rule fits 40 characters. `NaaS - ended line needs an end date` is 35.
- A function wired from Fluent names its parameter after the platform global: `current`.
- A stored choice value is named from `src/server/domain/vocabulary.ts`, never typed as a literal
  in server code.
- `npm run build` rewrites the tracked `src/fluent/generated/keys.ts`. A new record adds an entry
  to it. Commit it with the change.
- A test is a `*.test.ts` file beside its module. `npx vitest run src/server/domain` needs no build.
  `npm test` needs `npm run build` first. `npm run check` does both.
- When documented behaviour changes, the spec line changes in the same commit.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| This plan's tests | `npx vitest run src/server/domain/billing.test.ts` | all pass |
| Build | `npm run build` | exit 0; rewrites `dist/` and `src/fluent/generated/keys.ts` |
| Built-metadata checks | `npx vitest run src/server/built-metadata.test.ts` (after a build) | all pass |
| Full gate | `npm run check` | exit 0, all tests pass |

## Scope

**In scope** (the only files you should modify):

- `src/server/domain/billing.ts` (one new exported function)
- `src/server/domain/billing.test.ts` (one import, one `describe`)
- `src/server/entry/agreements.ts` (one import, one new exported function)
- `src/fluent/agreements/logic.now.ts` (two imports, one new rule)
- `src/fluent/generated/keys.ts` (rewritten by `npm run build`; never edit it by hand)
- `docs/spec/p3-billing.md`
- `docs/verify-on-instance.md`

**Out of scope** (do NOT touch, even though they look related):

- `src/server/platform/billing.ts` and `src/server/domain/money.ts`. Generation keeps going by the
  dates.
- `src/fluent/agreements/tables.now.ts`. The End date stays optional in the dictionary: a pending
  or active line has none.
- `src/server/platform/subscriptions.ts`. `endSitePackageIfEmpty` sets both fields already.
- `IN_SERVICE_ON_ENDED_LINE` and `chooseSubscriptionLine`. They stay as they are.
- A fix script or a job that gives existing ended lines an End date. Only finance knows the dates.
  The plan documents how to list them.
- `src/server/test-support/fake-glide.ts`. It has no `setAbortAction`, so the entry function gets no
  unit test here (see "Test plan").
- An ATF test. Deferred (see "Maintenance notes").
- A line that is *Ended* with an End date in the future. It bills through that date, as today.

## Git workflow

- Branch: `advisor/025-ended-line-needs-end-date`, from `main`.
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example
  `Refuse a Subscription line set Ended without an End date`. The body says what was wrong and why
  (billing goes by the dates, so an Ended line with no End date was billed every month).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Branch and confirm the baseline

```sh
git checkout main && git checkout -b advisor/025-ended-line-needs-end-date
npx vitest run src/server/domain/billing.test.ts
grep -rn "SUBSCRIPTION_LINE_STATUS.ended" src/server --include=*.ts | grep setValue
```

**Verify**: the tests report 0 failed (55 passed at the planned-at commit). The `grep` prints one
line, `src/server/platform/subscriptions.ts:102`, and the line after it in that file sets
`end_date`. If it prints any other line, see the STOP conditions.

### Step 2: Write the failing test

Edit `src/server/domain/billing.test.ts`.

In the import from `'./billing'` at the top of the file, add the name `endedLineProblem` directly
after `decideGenerationReset,`:

```ts
    decideGenerationReset,
    endedLineProblem,
```

Insert this block directly above the line `describe('IN_SERVICE_UNBILLED', () => {`, followed by one
blank line:

```ts
describe('endedLineProblem', () => {
    it('refuses a line set Ended without an End date, which billing would take as still open', () => {
        expect(endedLineProblem({ status: 'ended', endDate: '' })).toBe(
            'An Ended subscription line needs an End date, the last day it is billed: enter it (today, if the line ends now)',
        )
    })

    it('lets an Ended line through with its End date, and a line that is not ended with or without one', () => {
        expect(endedLineProblem({ status: 'ended', endDate: '2026-11-12' })).toBeNull()
        for (const status of ['pending', 'active']) {
            expect(endedLineProblem({ status, endDate: '' }), status).toBeNull()
            expect(endedLineProblem({ status, endDate: '2026-11-12' }), status).toBeNull()
        }
    })
})
```

**Verify**: `npx vitest run src/server/domain/billing.test.ts` → `2 failed | 55 passed`. Both new
tests fail with `TypeError: endedLineProblem is not a function`. If any other test fails, STOP.

### Step 3: Add the domain function

In `src/server/domain/billing.ts`, insert this block directly above the line
`const NO_LINE = 'x_daas_ham_subscription_lineISEMPTY'`, followed by one blank line:

```ts
/**
 * Why a Subscription line cannot be saved as it is, or null: one set Ended needs its End date. Billing goes by a
 * line's dates and takes one without an End date as still open, whatever its status, so an Ended line without one
 * would be billed every month. The End date is the last day billed, which only whoever ends the line knows, so none
 * is filled in for them.
 */
export function endedLineProblem(line: { status: string; endDate: string }): string | null {
    if (line.status !== SUBSCRIPTION_LINE_STATUS.ended || line.endDate) return null
    return 'An Ended subscription line needs an End date, the last day it is billed: enter it (today, if the line ends now)'
}
```

**Verify**: `npx vitest run src/server/domain/billing.test.ts` → 57 passed, 0 failed.

### Step 4: Add the rule's function

Edit `src/server/entry/agreements.ts`.

Directly above the line `import { agreementCurrencyProblem, currencyCode } from '../domain/money.ts'`, add:

```ts
import { endedLineProblem } from '../domain/billing.ts'
```

Directly above the line `export function onAgreementTermsChanged(current: GlideRecord): void {`,
add this block, followed by one blank line:

```ts
/** A Subscription line set Ended is refused without its End date, which billing would take as still open. */
export function guardEndedSubscriptionLine(current: GlideRecord): void {
    abortWith(current, endedLineProblem({ status: str(current, 'status'), endDate: str(current, 'end_date') }))
}
```

`abortWith` and `str` are imported in that file already.

**Verify**: `npm run typecheck` → exit 0. `npm run lint` → exit 0.

### Step 5: Wire the rule

Edit `src/fluent/agreements/logic.now.ts`.

Directly after the line `import { PROPERTY } from '../../server/domain/properties'`, add:

```ts
import { SUBSCRIPTION_LINE_STATUS } from '../../server/domain/vocabulary'
```

In the import from `'../../server/entry/agreements'`, add the name `guardEndedSubscriptionLine`
directly after `guardAgreementCurrency,`:

```ts
    guardAgreementCurrency,
    guardEndedSubscriptionLine,
```

Insert this block directly above the rule `br_agreement_end_changed` (the line `BusinessRule({`
followed by `    $id: Now.ID['br_agreement_end_changed'],`), followed by one blank line:

```ts
// Billing goes by a line's dates: an Ended line with no End date would be billed as still open.
BusinessRule({
    $id: Now.ID['br_subscription_line_ended'],
    name: 'NaaS - ended line needs an end date',
    table: 'x_daas_ham_subscription_line',
    when: 'before',
    action: ['insert', 'update'],
    order: 100,
    condition: `current.status == '${SUBSCRIPTION_LINE_STATUS.ended}' && current.end_date == ''`,
    script: guardEndedSubscriptionLine,
})
```

Do not add `abortAction: true`. That is for rules on another scope's table, and the tests require
such a rule to load its check in its condition. This rule aborts from its script.

```sh
npm run build
git diff --numstat -- src/fluent/generated/keys.ts
git diff -- src/fluent/generated/keys.ts | grep "^[+-] "
npx vitest run src/server/built-metadata.test.ts
grep -l "NaaS - ended line needs an end date" dist/app/update/sys_script_*.xml | wc -l
```

**Verify**: the build exits 0. The `--numstat` line reads `4	0	src/fluent/generated/keys.ts`
(four lines added, none removed). The second command prints exactly four added lines, like these,
with another id:

```
+                    br_subscription_line_ended: {
+                        table: 'sys_script'
+                        id: '<32 hex characters>'
+                    }
```

The built-metadata tests all pass (75 at the planned-at commit). The last command prints `1`. Then
confirm what was built:

```sh
grep -o "<condition>[^<]*</condition>\|<collection>[^<]*</collection>\|<when>[^<]*</when>\|<action_insert>[^<]*</action_insert>\|<action_update>[^<]*</action_update>" "$(grep -l "NaaS - ended line needs an end date" dist/app/update/sys_script_*.xml)"
```

**Verify**: it prints these five lines, in any order (`&amp;&amp;` is `&&` as XML writes it):

```
<action_insert>true</action_insert>
<action_update>true</action_update>
<collection>x_daas_ham_subscription_line</collection>
<condition>current.status == 'ended' &amp;&amp; current.end_date == ''</condition>
<when>before</when>
```

### Step 6: Change the documents

In `docs/spec/p3-billing.md`, insert this bullet directly above the line that starts
`- The *Billing integrity* tab counts fleet assets only (ADR 0016)`:

```md
- Billing goes by a line's dates, not by its status: a line with no End date is still open. So a
  Subscription line cannot be saved *Ended* without an End date, the last day it is billed. A
  business rule refuses such a save, from a form, a list, an import or the Table API alike, and
  asks for the date. It fills none in, since only whoever ends the line knows its last day. The
  app's own ending of a site package sets both. A line saved *Ended* without an End date before
  this rule keeps being billed until it is given one (*Ended subscription lines* in
  `docs/verify-on-instance.md`).
```

In `docs/verify-on-instance.md`, insert this section directly above the line
`### Replacement SLA stop`, with one blank line before and after it:

```md
### Ended subscription lines

Open an active Subscription line, set *Status* to *Ended* with *End date* empty, and save. The save
is refused with *An Ended subscription line needs an End date, the last day it is billed: enter it
(today, if the line ends now)*, and the line keeps its status. Enter an End date and save: it is
written. Clear the End date of an Ended line and save: it is refused the same way. A list edit is
refused too.

**After an upgrade:** a line set *Ended* without an End date before this release is still billed
every month, and the rule refuses its next save until it has one. List Subscription lines with
*Status* *Ended* and an empty *End date* (`status=ended^end_dateISEMPTY`), and give each the last
day it should be billed. A Billing period still *Ready for review* that billed such a line past
that day is put right with *Regenerate*. A closed period is not changed: credit it by hand.
```

**Verify**:

- `grep -c "cannot be saved \*Ended\* without an End date" docs/spec/p3-billing.md` → `1`
- `grep -c "### Ended subscription lines" docs/verify-on-instance.md` → `1`

### Step 7: Run the full gate and commit

```sh
npm run check
git status --short
```

**Verify**: `npm run check` exits 0 and the test run reports 2 more passed tests than before this
plan (1806 in 113 files at the planned-at commit, 1839 if plans 023 and 024 landed).
`git status --short` lists exactly the seven in-scope files.

Commit the seven files in one commit, with the subject from "Git workflow" and a body that says
what was wrong and why.

## Test plan

- `src/server/domain/billing.test.ts`, 2 new tests in one `describe`, modelled on
  `describe('billingMonthProblem', ...)` at the top of that file (a pure function that gives the
  reason a save is refused, or null):
  - the regression this plan fixes: Status *Ended* with no End date gives the refusal, word for word;
  - an Ended line with an End date passes, and so does a pending or an active line, with or without
    an End date.
- Verification: `npx vitest run src/server/domain/billing.test.ts` → 57 passed.
- The wiring is checked by the build and by `src/server/built-metadata.test.ts`: the rule's name
  fits 40 characters, its condition fits 254, and its script calls `guardEndedSubscriptionLine`
  with the platform global `current`. Step 5 also reads the built record.

What the tests cannot show: `guardEndedSubscriptionLine` itself has no unit test. The fake Glide
has no `setAbortAction`, and this plan does not extend it. The function is one line that hands the
domain function's answer to `abortWith`, as `guardAgreementCurrency` does. That the instance runs
the condition as written, shows the message and refuses the save can only be confirmed on an
instance.

Local and instance checks: every done criterion below is local. The instance check is the new
section of `docs/verify-on-instance.md` (step 6). It is the final proof of this fix and it is not
run by this plan. Say in your report that it was not run, unless you ran it.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npx vitest run src/server/domain/billing.test.ts` reports 0 failed and 57 passed
- [ ] `npm run check` exits 0
- [ ] `grep -c "export function endedLineProblem" src/server/domain/billing.ts` prints `1`
- [ ] `grep -c "export function guardEndedSubscriptionLine" src/server/entry/agreements.ts` prints `1`
- [ ] `grep -c "br_subscription_line_ended" src/fluent/agreements/logic.now.ts` prints `1`
- [ ] `git diff --numstat main..HEAD -- src/fluent/generated/keys.ts` reads `4	0	src/fluent/generated/keys.ts`
- [ ] `git diff --stat main..HEAD -- src/server/platform src/server/domain/money.ts src/fluent/agreements/tables.now.ts` prints nothing
- [ ] The two `grep -c` checks of step 6 each print `1`
- [ ] `git status --short` is empty and only the seven in-scope files differ from `main`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts.
- The `grep` of step 1 finds another place in `src/server` that sets a line *Ended*. If that code
  does not set `end_date` in the same save, the new rule would refuse the app's own save. Report
  the file and line.
- A rule on `x_daas_ham_subscription_line` that sets or checks the End date exists already
  (`grep -rn "x_daas_ham_subscription_line" src/fluent --include=*.now.ts | grep -v "tables.now.ts\|access.now.ts\|forms.now.ts\|platform-tables.now.ts"`
  prints only the `shared/visibility.now.ts` line at the planned-at commit).
- Step 2 gives a different set of failing tests than the two new ones.
- The `keys.ts` diff of step 5 shows a removed line, or more than the one new entry. A removed
  entry means a Fluent record was deleted or renamed by mistake, and the build would then generate
  delete records. Report the diff.
- `npx vitest run src/server/built-metadata.test.ts` fails after step 5. Report the test name and
  message.
- The built condition of step 5 differs from the one shown.
- You are tempted to fill in an End date, to change the generation query, or to make the End date
  mandatory in the dictionary. Those were considered and rejected (see "The decision").
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The rule holds one invariant: *Ended* implies an End date. It does not hold the reverse. A line
  that is *Active* with an End date in the past is billed up to that date and counted by the tile
  as past its end date, which is consistent. No job sets such a line *Ended*.
- A line that is *Ended* with an End date in the future is saved. It bills through that date,
  while go-live already attaches no unit to it and the tile already counts its units. If that
  should be refused too, extend `endedLineProblem` with today's date and its test. It was left
  alone here because no finding showed it billing wrongly.
- New code that sets a line *Ended* must set `end_date` in the same save, as
  `endSitePackageIfEmpty` does, or the rule refuses it. A refused save returns no sys_id, so check
  the result of `update()`.
- Deferred: an ATF test that inserts a line with Status *Ended* and no End date and expects no
  record. It would prove the rule on an instance. ATF tests run on an instance only
  (`docs/verify-on-instance.md#running-atf`), and adding one means a new test record and its suite
  entry, which is more than this fix needs.
- Deferred: `setAbortAction` on the fake Glide. With it, this guard and the other guards on the
  app's own tables (`guardAgreementCurrency`, `guardBillingPeriodMonth`) could be unit-tested
  through their entry functions.
- Lines already *Ended* without an End date on an installed instance are not repaired. The new
  section of `docs/verify-on-instance.md` says how to list them. Until they are fixed they are
  billed as before.
- A reviewer should check three things: that the condition is state-based (it does not use
  `.changes()`), so a cleared End date is caught too; that `keys.ts` gained exactly one entry; and
  that the refusal text in the domain function, its test and `docs/verify-on-instance.md` is the
  same, word for word.
