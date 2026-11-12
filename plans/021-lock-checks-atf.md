# Plan 021: Check a job lock's row, release and abandonment in an ATF test

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1864b17..HEAD -- src/fluent/operations src/fluent/shared/test-suites.now.ts src/server/built-metadata.test.ts src/server/platform/locks.ts src/server/domain/job-lock.ts docs/verify-on-instance.md package.json`
> Some drift is expected and is not a STOP: other plans add tests to
> `test-suites.now.ts`, and plan 008 adds lock subsections to
> `docs/verify-on-instance.md` and names to `domain/lock-names.ts`. For every
> file listed, compare the "Current state" excerpts against the live code. A
> mismatch in an excerpt itself is a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `plans/001-lint-tracked-sources.md` (so `npm run lint` is a usable gate), `plans/008-job-run-locks.md` (it edits the same "Job locks" section of `docs/verify-on-instance.md`; land it first so the two do not conflict)
- **Category**: direction
- **Planned at**: commit `1864b17`, 2026-11-12

## Why this matters

Every concurrency guard in the app is a job lock: a row in `x_daas_ham_job_lock` behind a unique
index (ADR 0013). The unit tests run against an in-memory stand-in for Glide that only assumes how
the instance treats that row. Whether the index really refuses a second row without throwing,
whether a run really leaves no row behind, and whether an old row is really cleared are checked by
hand today, from a list in `docs/verify-on-instance.md`. A manual check is skipped under time
pressure, and a lock that silently does not exclude breaks sourcing, billing and receiving at once.

After this plan, one ATF test checks those properties on the instance in seconds, on every suite
run. The two-session checks (what each job says when it finds its lock held) stay manual.

## Current state

### The lock (read only, do not change)

- `src/server/platform/locks.ts`: takes and releases locks. The test calls two of its exports.

  ```ts
  // src/server/platform/locks.ts:37-39
  export function withLock<T>(name: string, work: Work<T>): LockRun<T> {
      return withLockTries(name, work, 1)
  }
  // src/server/platform/locks.ts:71-73
  export function isLocked(name: string): boolean {
      return exists(LOCK_TABLE, `name=${name}^sys_created_on>=${abandonedBefore()}`)
  }
  // src/server/platform/locks.ts:79-84 (the take: insert, clear an abandoned row, insert again)
  function take(name: string): string | null {
      const first = insertLock(name)
      if (first.id) return first.id
      clearAbandoned(name)
      const second = insertLock(name)
      if (second.id) return second.id
  ```

  `withLock` returns `{ ran: true, value }` or `{ ran: false }`. Its doc comment (lines 31-36) says
  it is not reentrant and that the work's own errors escape. The work receives a `HeldLock` with a
  `held()` method (`src/server/domain/job-lock.ts:44-45`).
- `src/server/domain/job-lock.ts:11`: `export const ABANDONED_AFTER_MINUTES = 10`. A row older than
  that is cleared by the next take.
- `src/fluent/operations/operations.now.ts:47-58`: the table. Its only column is `name`, with the
  unique index.

  ```ts
  export const x_daas_ham_job_lock = Table({
      name: 'x_daas_ham_job_lock',
      label: 'Job lock',
      display: 'name',
      // Locks are taken and released all the time; their deletes are not worth keeping in Deleted Records.
      attributes: { no_audit_delete: true },
      schema: {
          name: StringColumn({ label: 'Lock', maxLength: LOCK_NAME_LENGTH, mandatory: true }),
      },
      index: [{ name: 'x_daas_ham_jl_name', unique: true, element: 'name' }],
  })
  ```

- `src/fluent/operations/` holds one file today, `operations.now.ts`. There is no
  `src/fluent/operations/tests.now.ts`.

### How ATF tests are written here

- README.md "Where a Fluent record goes" (line 393): "ATF tests are `tests.now.ts`" in the feature's
  folder. Locks belong to `operations` ("job cursors and locks", README line 384).
- A script step is text in a template literal. The model is
  `src/fluent/delivery/tests.now.ts:22-31` and `:74-76`:

  ```ts
  export const trackingWebhookTest = Test(
      {
          $id: Now.ID['atf_tracking_webhook'],
          name: 'NaaS - the tracking webhook needs its token and records a delivery once',
          description: '...',
          active: true,
          failOnServerError: false,
      },
      (atf) => {
  ...
          atf.server.runServerSideScript({
              $id: Now.ID['atf_twh_deliver_twice'],
              script: `(function (outputs, steps, params, stepResult, assertEqual) {
  ```

- A script loads a server module by its installed path, which names the version in `package.json`
  (`"version": "0.1.0"` today). Example, `src/fluent/orders/tests.now.ts:365`:
  `var orders = require('x_daas_ham/naas-ham/0.1.0/src/server/entry/orders.ts');`
- Every test must be in exactly one suite. `src/fluent/shared/test-suites.now.ts:25-44`:

  ```ts
  import { rackPowerBudgetTest } from '../racks/tests.now'

  export const phase1Suite = TestSuite({
      $id: Now.ID['atf_suite_p1'],
      name: 'NaaS - P1',
      tests: [
          customerAdminVisibilityTest,
          ...
          cancelRefusedOnceShippedTest,
          sparePoolTopUpTest,
      ],
  })
  ```

- A `.now.ts` file is evaluated by the SDK, not run. It holds constants and template literals. Do
  not add a function call, loop, spread or array element lookup outside the `Test(...)` shape shown.
- A new Fluent record gets its sys_id from `$id: Now.ID['...']`. The build writes the key to the
  tracked file `src/fluent/generated/keys.ts`. Commit that file.

### What the local checks do with a script step

`src/server/built-metadata.test.ts` reads every built "Run Server Side Script" step (it needs
`npm run build` first) and holds each script to these rules:

- It starts with `(function`, contains no `{{`, and loads a module with exactly
  `var <name> = require('<path>')` (line 1414). The path must be a built module, and every
  `<name>.<fn>` in the script must be an exported function of it (lines 1421-1436).
- It is run locally with stand-ins (lines 1509-1532). `require` returns a stand-in whose every
  function returns `undefined`. `GlideRecord` is a stand-in with only a few read methods (no
  `initialize`, `setValue`, `insert` or `deleteRecord`). There is no `GlideDateTime`. The rule:

  ```ts
  // src/server/built-metadata.test.ts:1523-1530
      // A step passes or fails by what its script returns. Run here, a script fails only on the reply it checks, which a
      // stand-in answers HTTP 599: one that fails for another reason, or returns nothing, has an error of its own.
      it('run their scripts to a verdict', () => {
          for (const { step, script } of stepScripts()) {
              const { verdict, message } = run(script)
              expect({ step, verdict: typeof verdict }).toEqual({ step, verdict: 'boolean' })
              if (verdict === false) expect(message, step).toMatch(/expected HTTP/)
              expect(message, step).not.toMatch(/TypeError|ReferenceError|is not a function|is not defined|undefined/)
  ```

So each new script must reach `return false` on the stand-ins before it touches a `GlideRecord`
write, with a message this rule accepts. The scripts in step 2 do that: their first act is
`locks.isLocked(NAME)`, which the stand-in answers `undefined`, and they report
`expected the lock <name> to be free before the test`. Step 4 teaches the rule that message.

### The manual checks this plan automates

`docs/verify-on-instance.md:486-508`:

```md
### How a job lock behaves

A job lock is a row in *Job lock* (`x_daas_ham_job_lock`) named after what it guards, such as
`receive_asset_<Asset sys_id>`: taking it is one insert, and letting it go deletes the row. Check
once that *Job lock* shows a unique database index on *Lock*, and that a second row with the same
name is refused (`GlideRecord.insert()` returns no sys_id) without throwing.

Every lock below behaves as follows, which its own check does not repeat:

- **Errors in the system log.** A take tries the insert, clears the lock if it is abandoned, and
  tries again, so a take that finds the lock held logs two *Unique Key violation* errors. ...
- **Holding a lock by hand.** A row created by hand in *Job lock* with the lock's name (the sys_ids
  it names filled in) holds the lock, as another run would. Delete the row and the next run, event,
  scan or press goes ahead.
- **Abandoned locks.** A row created longer ago than `ABANDONED_AFTER_MINUTES` is taken as abandoned
  (`src/server/domain/job-lock.ts` owns that time and the try and re-queue counts below) and cleared
  by the
  next take, which then goes ahead; a fresh one is not cleared.
- **Nothing left behind.** No lock row is left once the run, request or action that took it ends.
```

### Design decisions already made (do not reopen)

- **The sample run is `withLock` itself**, under a lock name the step makes for the run
  (`atf_lock_run_<guid>`). It calls no job. So the test holds whether or not plan 008's run locks
  for the lease review, attestation and overdue jobs exist, and it can never meet a real job or
  raise real records. The names are not entries of `LOCK` in `domain/lock-names.ts`: that list is
  for locks the app takes, and its order (ADR 0013) does not apply to a test that holds one lock.
- **A take that finds its lock held logs errors** (two *Unique Key violation* errors, see the doc
  excerpt). So the test sets `failOnServerError: false`, as the tracking webhook test does.
- **Ageing a lock row.** `GlideRecord.autoSysFields(false)` is not available to scoped
  applications. The third step sets `sys_created_on` on insert and reads the row back. Whether the
  instance keeps that value is not known at planning time. If it does not, the step fails with a
  message that starts `NOT BACK-DATED`. That outcome is a limit of the test, not a defect of the
  app. See "STOP conditions".
- **Proof at planning time.** The three scripts were run against the real `platform/locks.ts` on
  the repo's in-memory Glide: steps 1 and 2 pass, step 1 fails with *no unique index* when the index
  is taken away, step 3 passes when a created time set on insert is kept and reports
  `NOT BACK-DATED` when it is not. The file in step 2 was also built in a scratch clone, where the
  local checks behaved as steps 3 and 4 below say.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 (needs plan 001; before it, use `npx eslint src`) |
| Build | `npm run build` | exit 0, ends with `Build completed successfully`; rewrites `dist/` and `src/fluent/generated/keys.ts` |
| The built-metadata checks | `npx vitest run src/server/built-metadata.test.ts` | all pass (72 tests at `1864b17`) |
| Full gate | `npm run check` | exit 0, all tests pass |

`src/server/built-metadata.test.ts` fails whenever a file under `src/fluent` or `src/server` is
newer than `dist/app`. Run `npm run build` before it, every time you edit one of those files.

## Scope

**In scope** (the only files you should modify):

- `src/fluent/operations/tests.now.ts` (create)
- `src/fluent/shared/test-suites.now.ts` (one import, one list entry)
- `src/server/built-metadata.test.ts` (one comment, one regular expression, lines 1523-1529)
- `src/fluent/generated/keys.ts` (rewritten by the build; commit it, do not edit it by hand)
- `docs/verify-on-instance.md` (the "How a job lock behaves" subsection only)

**Out of scope** (do NOT touch, even though they look related):

- `src/server/platform/locks.ts`, `src/server/domain/job-lock.ts`, `src/server/domain/lock-names.ts`,
  `docs/adr/0013-*.md`: the lock itself. This plan tests it and changes nothing in it. A test step
  that fails on the instance is a finding to report, not a reason to edit these.
- The stand-ins in `src/server/built-metadata.test.ts` (`FoundRecord`, `standInModule`, `run`): the
  scripts are written to need no new stand-in method.
- The other lock subsections of `docs/verify-on-instance.md` ("Margin recompute lock" through
  "Return label, Ship and tracking locks", and any that plan 008 added): they describe what each
  job does when its lock is held, which needs two sessions and stays manual.
- `src/server/test-support/fake-glide.ts`: it is not involved.

## Git workflow

- Branch: `advisor/021-lock-checks-atf`
- One commit for the whole plan. Subject in the repo's style (an imperative sentence under 72
  characters), for example: `Check a job lock's row, release and abandonment in ATF`. The body says
  what was checked by hand before and what the test now checks.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the facts the scripts rely on

Run these and compare:

```sh
grep -n "export function withLock\|export function isLocked" src/server/platform/locks.ts
grep -n "ABANDONED_AFTER_MINUTES = " src/server/domain/job-lock.ts
grep -n '"name"\|"version"' package.json
ls src/fluent/operations
grep -c "atf_jl_\|atf_job_lock" src/fluent/generated/keys.ts
```

**Verify**: the first prints two lines (`withLock`, `isLocked`). The second prints
`export const ABANDONED_AFTER_MINUTES = 10`. The third prints `"name": "naas-ham"` and
`"version": "0.1.0"`. The fourth prints only `operations.now.ts`. The fifth prints `0`.

If the version is not `0.1.0`, use the version you see in the three `require(...)` paths of step 2.
If `ABANDONED_AFTER_MINUTES` is 60 or more, STOP (the third script ages its row by one day and
treats anything newer than one hour as not back-dated; a longer abandonment time needs new numbers).

### Step 2: Create the test

Create `src/fluent/operations/tests.now.ts` with exactly this content. Do not reformat the scripts:
they are text, and the local checks read them as written. They hold no backtick, no `${` and no
apostrophe inside a string.

```ts
import '@servicenow/sdk/global'
import { Test } from '@servicenow/sdk/core'

/*
 * Job locks (ADR 0013) as the instance keeps them, which the unit tests' stand-in for Glide only assumes: the unique
 * index on Lock refuses a second row without throwing, a row made by hand holds the lock, a run leaves no row behind,
 * and a row older than ABANDONED_AFTER_MINUTES (domain/job-lock) is cleared by the next take. Each step takes a lock
 * name of its own, made for the run, so it meets no job and no other run of the test. A step probes its lock through
 * platform/locks before it writes: the first failure it can report is that the lock is not free.
 */
export const jobLockTest = Test(
    {
        $id: Now.ID['atf_job_lock'],
        name: 'NaaS - a job lock is one row that only one holder takes',
        description:
            'Under lock names of its own: a second Job lock row of one name is refused without throwing, and a row made by hand holds the lock until it is deleted; a run through withLock holds one row, refuses a nested take and leaves no row, also when its work throws; a row created a day ago is cleared by the next take, which runs.',
        active: true,
        // A take that finds its lock held logs each refused insert as a Unique Key violation error: the expected path.
        failOnServerError: false,
    },
    (atf) => {
        atf.server.runServerSideScript({
            $id: Now.ID['atf_jl_unique'],
            script: `(function (outputs, steps, params, stepResult, assertEqual) {
    var locks = require('x_daas_ham/naas-ham/0.1.0/src/server/platform/locks.ts');
    var TABLE = 'x_daas_ham_job_lock';
    var NAME = 'atf_lock_unique_' + gs.generateGUID();
    var touched = false;
    function insertRow() {
        var row = new GlideRecord(TABLE);
        row.initialize();
        row.setValue('name', NAME);
        return row.insert();
    }
    function rowCount() {
        var row = new GlideRecord(TABLE);
        row.addQuery('name', NAME);
        row.query();
        return row.getRowCount();
    }
    function clear() {
        var row = new GlideRecord(TABLE);
        row.addQuery('name', NAME);
        row.query();
        while (row.next()) row.deleteRecord();
    }
    try {
        if (locks.isLocked(NAME) !== false) throw new Error('expected the lock ' + NAME + ' to be free before the test');
        touched = true;
        if (!insertRow()) throw new Error('The first lock row was refused');
        var second = null;
        try {
            second = insertRow();
        } catch (e) {
            throw new Error('A second row of the same name threw instead of being refused: ' + e);
        }
        if (second) throw new Error('A second row of the same name was inserted: Job lock has no unique index on Lock');
        if (rowCount() !== 1) throw new Error('Job lock holds ' + rowCount() + ' rows of one name, not 1');
        if (locks.isLocked(NAME) !== true) throw new Error('A fresh row made by hand does not hold the lock');
        var ran = false;
        var attempt = locks.withLock(NAME, function () { ran = true; return true; });
        if (ran || attempt.ran !== false) throw new Error('withLock ran its work while a row made by hand held the lock');
        if (rowCount() !== 1) throw new Error('A take cleared a fresh lock row');
        clear();
        var after = locks.withLock(NAME, function () { return 'ran'; });
        if (after.ran !== true || after.value !== 'ran') throw new Error('withLock did not run once the row made by hand was deleted');
        stepResult.setOutputMessage('A second row named ' + NAME + ' was refused without throwing; held by hand, the lock was not taken; deleted, it was');
        return true;
    } catch (e) {
        stepResult.setOutputMessage(String(e && e.message ? e.message : e));
        return false;
    } finally {
        if (touched) clear();
    }
})(outputs, steps, params, stepResult, assertEqual);`,
        })
        atf.server.runServerSideScript({
            $id: Now.ID['atf_jl_run'],
            script: `(function (outputs, steps, params, stepResult, assertEqual) {
    var locks = require('x_daas_ham/naas-ham/0.1.0/src/server/platform/locks.ts');
    var TABLE = 'x_daas_ham_job_lock';
    var NAME = 'atf_lock_run_' + gs.generateGUID();
    var touched = false;
    function rowCount() {
        var row = new GlideRecord(TABLE);
        row.addQuery('name', NAME);
        row.query();
        return row.getRowCount();
    }
    function clear() {
        var row = new GlideRecord(TABLE);
        row.addQuery('name', NAME);
        row.query();
        while (row.next()) row.deleteRecord();
    }
    try {
        if (locks.isLocked(NAME) !== false) throw new Error('expected the lock ' + NAME + ' to be free before the test');
        touched = true;
        var inside = null;
        var run = locks.withLock(NAME, function (lock) {
            inside = {
                held: lock.held(),
                rows: rowCount(),
                locked: locks.isLocked(NAME),
                nested: locks.withLock(NAME, function () { return true; }).ran
            };
            return 'done';
        });
        if (run.ran !== true || run.value !== 'done') throw new Error('withLock did not run its work on a free lock');
        if (inside.held !== true || inside.rows !== 1 || inside.locked !== true) throw new Error('The work did not hold one lock row: ' + JSON.stringify(inside));
        if (inside.nested !== false) throw new Error('A nested take of the lock ran: locks are not re-entrant');
        if (rowCount() !== 0) throw new Error('A run that ended left its lock row behind');
        var escaped = false;
        try {
            locks.withLock(NAME, function () { throw new Error('ATF work failed'); });
        } catch (e) {
            escaped = true;
        }
        if (!escaped) throw new Error('What the work threw did not escape withLock');
        if (rowCount() !== 0) throw new Error('Work that threw left its lock row behind');
        stepResult.setOutputMessage('A run held ' + NAME + ' as one row, a nested take was refused, and no row was left, also after work that threw');
        return true;
    } catch (e) {
        stepResult.setOutputMessage(String(e && e.message ? e.message : e));
        return false;
    } finally {
        if (touched) clear();
    }
})(outputs, steps, params, stepResult, assertEqual);`,
        })
        atf.server.runServerSideScript({
            $id: Now.ID['atf_jl_abandoned'],
            script: `(function (outputs, steps, params, stepResult, assertEqual) {
    var locks = require('x_daas_ham/naas-ham/0.1.0/src/server/platform/locks.ts');
    var TABLE = 'x_daas_ham_job_lock';
    var NAME = 'atf_lock_abandoned_' + gs.generateGUID();
    var touched = false;
    function rowCount() {
        var row = new GlideRecord(TABLE);
        row.addQuery('name', NAME);
        row.query();
        return row.getRowCount();
    }
    function clear() {
        var row = new GlideRecord(TABLE);
        row.addQuery('name', NAME);
        row.query();
        while (row.next()) row.deleteRecord();
    }
    try {
        if (locks.isLocked(NAME) !== false) throw new Error('expected the lock ' + NAME + ' to be free before the test');
        touched = true;
        var dayAgo = new GlideDateTime();
        dayAgo.addSeconds(-86400);
        var row = new GlideRecord(TABLE);
        row.initialize();
        row.setValue('name', NAME);
        row.setValue('sys_created_on', dayAgo.getValue());
        var id = row.insert();
        if (!id) throw new Error('The back-dated lock row was refused');
        var stored = new GlideRecord(TABLE);
        if (!stored.get(id)) throw new Error('The back-dated lock row was not found again');
        var hourAgo = new GlideDateTime();
        hourAgo.addSeconds(-3600);
        var created = String(stored.getValue('sys_created_on'));
        if (created >= hourAgo.getValue()) throw new Error('NOT BACK-DATED: the instance stamped the row ' + created + ', so this step cannot age a lock; check an abandoned lock by hand (docs/verify-on-instance.md, Job locks)');
        if (locks.isLocked(NAME) !== false) throw new Error('An abandoned lock row counts as held');
        var run = locks.withLock(NAME, function () {
            var old = new GlideRecord(TABLE);
            return old.get(id) ? 'kept' : 'cleared';
        });
        if (run.ran !== true) throw new Error('The take did not clear the abandoned lock and run');
        if (run.value !== 'cleared') throw new Error('The work ran beside the abandoned lock row, which was not cleared');
        if (rowCount() !== 0) throw new Error('A lock row was left behind after the abandoned one was taken over');
        stepResult.setOutputMessage('A lock row created ' + created + ' was cleared by the next take of ' + NAME + ', which ran and left no row');
        return true;
    } catch (e) {
        stepResult.setOutputMessage(String(e && e.message ? e.message : e));
        return false;
    } finally {
        if (touched) clear();
    }
})(outputs, steps, params, stepResult, assertEqual);`,
        })
    },
)
```

**Verify**: `npx eslint src/fluent/operations/tests.now.ts; echo "exit $?"` → `exit 0`. And
`grep -c "runServerSideScript" src/fluent/operations/tests.now.ts` → `3`.

### Step 3: Put the test in the P1 suite and build

In `src/fluent/shared/test-suites.now.ts`:

1. After the line `import { rackPowerBudgetTest } from '../racks/tests.now'` add:

   ```ts
   import { jobLockTest } from '../operations/tests.now'
   ```

2. In `phase1Suite`, add `jobLockTest,` as the last entry of `tests`, after `sparePoolTopUpTest,`
   (or after whatever entry is last there now):

   ```ts
           sparePoolTopUpTest,
           jobLockTest,
       ],
   ```

Then run `npm run build`.

**Verify**: the build ends with `Build completed successfully`. Then
`grep -c "atf_jl_\|atf_job_lock" src/fluent/generated/keys.ts` → `4`. Then
`npx vitest run src/server/built-metadata.test.ts` → exactly one test fails,
`ATF tests > run their scripts to a verdict`, with
`NaaS - a job lock is one row that only one holder takes step 1: expected 'expected the lock atf_lock_unique_bbb…' to match /expected HTTP/`.
That failure is wanted here: it shows the local checks read the new scripts, and that the scripts
stop at their first probe on the stand-ins. Any other failing test is a STOP condition.

### Step 4: Teach the local check the lock probe's verdict

In `src/server/built-metadata.test.ts`, replace the two comment lines and the one `expect` line
shown in "Current state" (lines 1523, 1524 and 1529). The result:

```ts
    // A step passes or fails by what its script returns. Run here, a script fails only on the reply it checks, which a
    // stand-in answers HTTP 599, or on the job lock it probes before it writes, which a stand-in module never says
    // is free: one that fails for another reason, or returns nothing, has an error of its own.
    it('run their scripts to a verdict', () => {
        for (const { step, script } of stepScripts()) {
            const { verdict, message } = run(script)
            expect({ step, verdict: typeof verdict }).toEqual({ step, verdict: 'boolean' })
            if (verdict === false) expect(message, step).toMatch(/expected HTTP|expected the lock/)
            expect(message, step).not.toMatch(/TypeError|ReferenceError|is not a function|is not defined|undefined/)
        }
    })
```

Change nothing else in that file.

**Verify**: `npx vitest run src/server/built-metadata.test.ts` → all pass, 0 failed. (No rebuild is
needed: a `*.test.ts` file is not a source the build reads.)

### Step 5: Say in the instance checklist what the test covers

In `docs/verify-on-instance.md`, in the subsection "### How a job lock behaves" only. The two
blocks below are indented because they sit in a list. Write their text at the left margin, as the
rest of that file is.

1. Replace its first paragraph (from `A job lock is a row in` to `without throwing.`) with:

   ```md
   A job lock is a row in *Job lock* (`x_daas_ham_job_lock`) named after what it guards, such as
   `receive_asset_<Asset sys_id>`: taking it is one insert, and letting it go deletes the row. The ATF
   test *NaaS - a job lock is one row that only one holder takes* (suite *NaaS - P1*) checks this on
   the instance, under lock names of its own. A second row with the same name is refused
   (`GlideRecord.insert()` returns no sys_id) without throwing. A row made by hand holds the lock
   until it is deleted. A run leaves no row behind, also when its work throws. A row older than
   `ABANDONED_AFTER_MINUTES` is cleared by the next take. Confirm that the test passes, and check once
   that *Job lock* shows a unique database index on *Lock*. The test's last step ages a row by setting
   `sys_created_on` on insert: if it reports *NOT BACK-DATED*, the instance stamped the row itself,
   and an abandoned lock is checked by hand, as below.
   ```

2. Directly after the bullet that starts `- **Nothing left behind.**` (the last bullet of the
   list), add a blank line and this paragraph:

   ```md
   The ATF test checks the last three of these for the lock itself. What each job, request or action
   does when it finds its lock held, and what it logs, is checked by hand in the sections below.
   ```

Leave the four bullets and every other subsection as they are.

**Verify**: `grep -c "NaaS - a job lock is one row that only one holder takes" docs/verify-on-instance.md`
→ `1`. And `grep -n "and that a second row with the same" docs/verify-on-instance.md` → prints
nothing (the old sentence is gone).

### Step 6: Run the full gate and commit

Run `npm run check`.

**Verify**: exit 0, no failed test. Then `git status --short` lists exactly these (apart from
anything under `plans/`):

```text
 M docs/verify-on-instance.md
 M src/fluent/generated/keys.ts
 M src/fluent/shared/test-suites.now.ts
 M src/server/built-metadata.test.ts
?? src/fluent/operations/tests.now.ts
```

Commit all five on `advisor/021-lock-checks-atf`.

### Step 7 (instance only, when an operator gives you an instance): run the test

Skip this step when you have no instance. The local criteria above are enough to hand the work
back; say in your report that the instance run is outstanding.

With an instance: install the app (`npm run deploy`, an operator decision), make sure the system
property `sn_atf.runner.enabled` is true, and run suite *NaaS - P1* as
`docs/verify-on-instance.md#running-atf` describes (`npx now-sdk cicd testsuite run --help` lists
the arguments).

**Verify**: the test *NaaS - a job lock is one row that only one holder takes* passes, each step
with an output message that starts `A second row named`, `A run held` and `A lock row created`. The
list *Job lock* filtered on *Lock starts with atf_lock* is empty afterwards. If step 3 of the test
fails with `NOT BACK-DATED`, or any step fails another way, see "STOP conditions".

## Test plan

- The deliverable is itself a test: one ATF Test of three script steps.
  - Step `atf_jl_unique`: the unique index refuses a second row without throwing; a fresh row made
    by hand holds the lock (`isLocked` true, `withLock` does not run, the row is not cleared); once
    it is deleted, `withLock` runs.
  - Step `atf_jl_run`: a run holds exactly one row, `lock.held()` is true, a nested take is refused,
    no row is left after it, and none is left after work that throws (the error escapes).
  - Step `atf_jl_abandoned`: a row created a day ago does not count as held and is cleared by the
    next take, which runs and leaves no row.
- Local proof that the scripts are well formed: `src/server/built-metadata.test.ts`, describe block
  `ATF tests` (in one suite, named, module path and exports exist, runs to a verdict). No new
  `it(...)` is added; the existing ones now also cover the three new scripts.
- Structural pattern: `src/fluent/delivery/tests.now.ts` (`trackingWebhookTest`).
- Verification: `npm run build && npx vitest run src/server/built-metadata.test.ts` → all pass.

## Done criteria

Local (all must hold; these are enough to hand the work back):

- [ ] `npm run check` exits 0
- [ ] `grep -c "runServerSideScript" src/fluent/operations/tests.now.ts` prints `3`
- [ ] `grep -c "jobLockTest" src/fluent/shared/test-suites.now.ts` prints `2`
- [ ] `grep -c "atf_jl_\|atf_job_lock" src/fluent/generated/keys.ts` prints `4`
- [ ] `grep -c "expected HTTP|expected the lock" src/server/built-metadata.test.ts` prints `1`
- [ ] `grep -c "NaaS - a job lock is one row that only one holder takes" docs/verify-on-instance.md` prints `1`
- [ ] `git diff --stat 1864b17..HEAD -- src/server/platform src/server/domain` shows no change made by this plan
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

Instance (needs an instance; report as outstanding when you have none):

- [ ] The test passes in suite *NaaS - P1*, and no *Job lock* row named `atf_lock...` is left

## STOP conditions

Stop and report back (do not improvise) if:

- An excerpt in "Current state" does not match the live code (beyond the expected drift named in
  the drift check).
- `npm run build` fails or warns on `src/fluent/operations/tests.now.ts`. The SDK may refuse a Test
  that has script steps only; this was not seen in the scratch build at planning time.
- After step 3, a test other than `ATF tests > run their scripts to a verdict` fails, or that test
  fails with a message that does not contain `expected the lock`.
- After step 4, `npx vitest run src/server/built-metadata.test.ts` still fails twice after a
  reasonable fix attempt. Do not add methods to the stand-ins to get past it.
- You find yourself wanting to edit `platform/locks.ts`, `domain/job-lock.ts` or
  `domain/lock-names.ts`.
- On an instance, step 3 of the test reports `NOT BACK-DATED`. The instance does not keep a
  `sys_created_on` set on insert from this scope. Do not weaken the step and do not make it pass
  silently. Report it. The operator then chooses between leaving the abandoned check manual
  (removing step `atf_jl_abandoned` and its sentence in the doc) and another way to age the row.
- On an instance, a script step fails with *require is not defined* or *No module with path*. The
  installed path in the scripts does not match the installed version.
- On an instance, step 1 or 2 of the test fails for any other reason. That is evidence about the
  lock on the platform (for example a second row was accepted). Report the step's output message
  word for word. It is not fixed under this plan.

## Maintenance notes

- The scripts spell out `x_daas_ham/naas-ham/0.1.0/src/server/platform/locks.ts`. When the version in
  `package.json` changes, `built-metadata.test.ts` fails until the three paths are updated, as for
  every other ATF script.
- The scripts call `locks.withLock` and `locks.isLocked` and read the table `x_daas_ham_job_lock`
  and its column `name`. A rename of any of them must reach `src/fluent/operations/tests.now.ts`.
  `built-metadata.test.ts` catches a renamed export, not a renamed table or column.
- The third script ages its row by one day and checks that the stored time is more than one hour
  old. Both numbers assume `ABANDONED_AFTER_MINUTES` stays well under an hour.
- Each step cleans up by lock name in a `finally`. A step killed mid-run by the instance could leave
  a row named `atf_lock_...`. It guards nothing the app takes and is cleared by hand.
- If the instance does not keep a back-dated `sys_created_on`, one untested idea is the platform's
  `GlideQuery` with `disableAutoSysFields()`, which runs in the global scope. It needs the lock
  table to accept writes from that scope. Treat it as a question for the owner, not a quick fix.
- Deferred on purpose: a local vitest that runs the built lock scripts against `platform/locks.ts`
  on the fake Glide. It was done by hand at planning time. It would need `getRowCount` on the fake
  and a way to keep a created time set on insert, which the fake does not model today.
- Reviewer: check that `failOnServerError: false` is on the test (the refused inserts log errors),
  and that the doc still tells the reader to confirm the result on the instance.
