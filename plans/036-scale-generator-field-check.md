# Plan 036: Hold the scale scripts to the app's columns and choices before they run on an instance

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- tools/scale src/server/built-metadata.test.ts docs/research/scale-test.md docs/verify-on-instance.md`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

`tools/scale/generate-fleet.js` and `tools/scale/cleanup-fleet.js` are pasted into *Scripts -
Background* on a dev instance to build and remove a test fleet. They name about 50 columns and
several choice values as plain texts (`'x_daas_ham_seen_source'`, `'nms'`, `'in_service'`).
Nothing checks those texts: the scripts are not built, `npm test` does not run them, and their dry
run (`tools/scale/dry-run.mjs`) uses an in-memory GlideRecord that accepts any field name. If a
column or a choice is renamed in the app, the generator still runs and the dry run still passes.
On the instance a `setValue` on a missing field is believed to write nothing (unconfirmed), so the
scale timings would measure the wrong data. A query on a missing field is believed to be ignored
(unconfirmed), so the cleanup could match rows it should not. After this plan, `npm test` runs the
dry run and fails when either script names a column the app does not have, sets a value that is no
choice of its column, or asks `newAsset` for a stage that does not exist.

## Current state

- `tools/scale/generate-fleet.js` (202 lines): the generator. Names fields as texts, for example
  lines 117-129:

  ```js
                  var asset = assets.newAsset(models[unit % models.length], 'in_service');
                  asset.setValue('serial_number', serial);
                  asset.setValue('asset_tag', 'SCL' + serial.slice(5));
                  asset.setValue('x_daas_ham_staging_source', 'in_house');
                  asset.setValue('company', customer);
                  asset.setValue('x_daas_ham_agreement', agreement);
                  asset.setValue('x_daas_ham_site', site);
                  asset.setValue('location', site);
                  asset.setValue('x_daas_ham_subscription_line', line);
                  asset.setValue('x_daas_ham_install_completed', '2026-02-01 08:00:00');
                  asset.setValue('x_daas_ham_in_service_date', '2026-02-01 09:00:00');
                  asset.setValue('x_daas_ham_last_seen', now);
                  asset.setValue('x_daas_ham_seen_source', 'nms');
  ```

  Other fields are keys of object literals handed to its `ensure(table, key, fields)` helper
  (lines 154-187), which calls `addQuery` and `setValue` for each. **You do not change this file.**
- `tools/scale/cleanup-fleet.js` (70 lines): deletes the generated rows. Its `STEPS` (lines 20-27)
  name a table and a field each, some dot-walked (`'asset.serial_number'`, `'customer.name'`).
  **You do not change this file.**
- `tools/scale/dry-run.mjs` (210 lines): runs both scripts against tables in memory with
  `node tools/scale/dry-run.mjs`. It is cheap (well under a second), reads only the two scripts,
  writes nothing, and prints one line that starts `dry run ok:`. Its assertions run at the top
  level of the module, so importing it runs the whole dry run. Its `instance()` function (line 17)
  holds a fake `GlideRecord` class. The parts you change:

  Lines 22-24:

  ```js
      const logs = []
      let ids = 0
      const rowsOf = (table) => (tables[table] ??= [])
  ```

  Lines 41-43, 63-65 and 72-74 (three methods of the fake `GlideRecord`):

  ```js
          addQuery(field, operator, value) {
              this.conditions.push(value === undefined ? [field, '=', operator] : [field, operator, value])
          }
  ```

  ```js
          get(field, value) {
              const [name, wanted] = value === undefined ? ['sys_id', field] : [field, value]
              const row = rowsOf(this.table).find((found) => String(found[name] ?? '') === String(wanted))
  ```

  ```js
          setValue(field, value) {
              this.row[field] = value
          }
  ```

  Lines 108-117 (the stand-in for `platform/assets.ts`), and lines 122-123:

  ```js
      const assets = {
          newAsset: (model, stage) => {
              const asset = new GlideRecord('alm_hardware')
              asset.initialize()
              asset.setValue('model', model)
              asset.setValue('stage', stage)
              asset.setValue('x_daas_ham_fleet', true)
              return asset
          },
      }
  ```

  ```js
      const count = (table) => rowsOf(table).length
      return { run, count, rowsOf }
  ```

  Lines 126-136 define `SHAPE`, `GENERATED`, `counts` and `NOTHING`. Line 135 is:

  ```js
  const counts = (dev) => Object.fromEntries(Object.keys(GENERATED).map((table) => [table, dev.count(table)]))
  ```

  `'stage'` in the stand-in `newAsset` is not a column of `alm_hardware`. Nothing in the dry run
  reads it back. The real `newAsset(modelId, stage)` (`src/server/platform/assets.ts:96`) takes a
  lifecycle stage, a key of `STAGE_FIELDS` (`src/server/domain/`), and writes install status and
  substatus from it.
- `src/server/built-metadata.test.ts` (Vitest, 75 tests at the planned-at commit) reads the built
  app in `dist/app`. Its `describe('fields the forms, lists and record producers name', ...)` block
  already checks that every field a form, list or workspace list names as a text is a column. Its
  `hasColumn(table, column)` (line 563) looks in the built dictionary (`dist/app/dictionary`, the
  app's own columns, also those it adds to platform tables), then in the table definitions the SDK
  ships (`node_modules/@servicenow/sdk-core/src/fluent/tables/<table>.now.ts`), then in the parent
  table. The block ends at lines 602-609:

  ```ts
      it('are columns of the table, or of one it extends: of a dot-walked field, the reference it starts from', () => {
          expect(shown().length).toBeGreaterThan(800)
          const missing = shown()
              .filter(({ table, field }) => !hasColumn(table, field.split('.')[0] ?? ''))
              .map(({ where, table, field }) => `${where}: ${table}.${field}`)
          expect(missing).toEqual([])
      })
  })
  ```

  The file already imports `existsSync`, `readFileSync` (`node:fs`), `join` (`node:path`) and
  `STAGE_FIELDS`, and defines `BUILT = join(ROOT, 'dist/app')`. You add no import.
- A choice column carries its choices in the built dictionary, which the build writes from
  `src/server/domain/vocabulary.ts`. Example, `dist/app/dictionary/alm_hardware.xml`:

  ```xml
  <element name="x_daas_ham_staging_source" type="choice" ...>
    <choice>
      <element value="in_house" label="In-house" .../>
      <element value="distributor" label="Distributor pre-staged (verify)" .../>
    </choice>
  </element>
  ```

  The same file's `describe('choices of the record producers', ...)` reads choices this way
  (`columnChoices`, about line 1287). The new test uses the same regular expression.
- Two platform tables the scripts name have no definition in the SDK: `customer_account` (extends
  `core_company`; the scripts name its own column `number`) and `cmdb_hardware_product_model`
  (extends `cmdb_model`, where the app's `x_daas_ham_oem_pid` is). The new test says so in a small
  table, as the block's `UNDEFINED_BY_SDK` (line 532) does for `cmdb_model_lifecycle`.
- `x_daas_ham_agreement` extends `ast_contract`. Its `state` is the platform's column, so the
  generator's `state: 'active'` is not a choice the built dictionary lists. Six columns the
  generator sets are choice columns of the app: `alm_hardware.x_daas_ham_staging_source`,
  `alm_hardware.x_daas_ham_seen_source`, `x_daas_ham_agreement.replacement_tier`,
  `x_daas_ham_agreement.refresh_basis`, `x_daas_ham_subscription_line.line_type` and
  `x_daas_ham_subscription_line.status`.
- Why the test goes in `built-metadata.test.ts` and not beside the scripts: `vitest.config.ts`
  includes `src/server/**/*.test.ts` and `src/client/**/*.test.ts` only, `tsconfig.test.json`
  type-checks the same folders, and the column check (`hasColumn`) lives inside that file's
  `describe` block. One more `it` there reuses all three with no config change.
- This change was trialled on a copy of the repo at the planned-at commit. The file's 76 tests
  passed, `npx tsc -p tsconfig.test.json --noEmit` and ESLint on the two changed files exited 0.
  Three trial edits of `generate-fleet.js` each failed the new test: a renamed column
  (`x_daas_ham_sitex`), a wrong choice (`'snmp'` for the seen source) and a wrong stage
  (`'in_use'`).
- Repo rules that apply (from `AGENTS.md`):
  - `npm test` needs `npm run build` first: `built-metadata.test.ts` fails when a file under
    `src/fluent` or `src/server` (tests aside) is newer than `dist/app`. This plan edits a test
    file and a file under `tools/`, neither of which counts. If the file already fails with
    `dist/app is older than ...` or `dist/app is missing` before your change, run `npm run build`.
  - `npm run build` rewrites the tracked `src/fluent/generated/keys.ts`. This plan changes no
    Fluent code, so that file must come out unchanged.
  - Lint skips what git ignores. Do not leave scratch files in the tree.
  - Comments say a why the code cannot show. Use the words of `CONTEXT.md` (Asset, Stage, fleet).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Dry run | `node tools/scale/dry-run.mjs` | one line starting `dry run ok:`, exit 0 |
| The one file | `npx vitest run src/server/built-metadata.test.ts` | `Tests  75 passed` before, `76 passed` after |
| The new test | `npx vitest run src/server/built-metadata.test.ts -t "scale scripts"` | `1 passed`, 75 skipped |
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| Full gate | `npm run check` | exit 0; 1805 tests pass (1804 at the planned-at commit) |

## Scope

**In scope** (the only files you should modify):
- `tools/scale/dry-run.mjs`
- `src/server/built-metadata.test.ts` (one new `it`, nothing else)
- `docs/research/scale-test.md` (one sentence)

**Out of scope** (do NOT touch):
- `tools/scale/generate-fleet.js` and `tools/scale/cleanup-fleet.js`, except for the temporary
  edit of step 4, which you revert. Do not make them import `vocabulary.ts`: they are pasted into
  the instance as they are and cannot import.
- `vitest.config.ts`, `tsconfig.test.json`, `package.json`, `eslint.config.js`.
- `hasColumn`, `shown()` and every existing test in `built-metadata.test.ts`.
- `docs/verify-on-instance.md`: its "Scale" entry stays true.
- Running anything on an instance. The instance run of the scale test awaits the owner.

## Git workflow

- Branch: `advisor/036-scale-generator-field-check`
- One commit with the three files. Subject is an imperative sentence under 72 characters in the
  repo's style (examples: `Refuse a server module that is not a .ts file`,
  `Count and list only fleet assets on the dashboard and workspace`). Suggested:
  `Hold the scale scripts to the built columns, choices and stages`. The body says the scripts
  name their fields as texts, that the dry run's GlideRecord took any name, and that the built
  metadata test now runs the dry run and checks what it named.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the starting point

```bash
node tools/scale/dry-run.mjs
npx vitest run src/server/built-metadata.test.ts
grep -c "asset.setValue('stage', stage)" tools/scale/dry-run.mjs
```

**Verify**: the first prints a line starting `dry run ok:`. The second ends with
`Tests  75 passed (75)`. The third prints `1`. If the second fails with `dist/app is older than`
or `dist/app is missing`, run `npm run build`, confirm `git status --short` shows no change to
`src/fluent/generated/keys.ts`, and run it again.

### Step 2: Make the dry run record what the scripts name

Edit `tools/scale/dry-run.mjs`. Six small changes, all inside `instance()` except the last.

1. After `const logs = []` add two lines:

   ```js
       const logs = []
       const named = []
       const stages = []
       let ids = 0
   ```

2. First line of `addQuery`:

   ```js
           addQuery(field, operator, value) {
               named.push({ table: this.table, field })
               this.conditions.push(value === undefined ? [field, '=', operator] : [field, operator, value])
           }
   ```

3. In `get`, after the line that computes `name` and `wanted`:

   ```js
               const [name, wanted] = value === undefined ? ['sys_id', field] : [field, value]
               named.push({ table: this.table, field: name })
   ```

4. First line of `setValue`:

   ```js
           setValue(field, value) {
               named.push({ table: this.table, field, value })
               this.row[field] = value
           }
   ```

5. In the stand-in `newAsset`, replace `asset.setValue('stage', stage)` with `stages.push(stage)`,
   and return the two lists from `instance()`:

   ```js
               asset.setValue('model', model)
               stages.push(stage)
               asset.setValue('x_daas_ham_fleet', true)
   ```

   ```js
       return { run, count, rowsOf, named, stages }
   ```

6. Directly before the line `const counts = (dev) => ...` (line 135 before your edits), add an
   exported function, with one blank line before and after it:

   ```js
   /** Every field the two scripts name on a table, with the value they set, and every stage they hand to newAsset. */
   export function scaleScriptNames() {
       const dev = instance()
       dev.run(GENERATE, { ...SHAPE, confirm: INSTANCE })
       dev.run(CLEANUP, { confirm: INSTANCE, maxRowsPerRun: 5000, budgetSeconds: 120 })
       return { named: dev.named, stages: dev.stages }
   }
   ```

Change no assertion and no other line.

**Verify**: `node tools/scale/dry-run.mjs` prints the same `dry run ok:` line as in step 1, exit 0.

**Verify**: this prints `54 [ 'in_service' ]` (the first number may differ by a few if the
scripts changed; it must be above 40):

```bash
node -e "import('./tools/scale/dry-run.mjs').then((m) => { const { named, stages } = m.scaleScriptNames(); console.log(new Set(named.map((n) => n.table + '.' + n.field)).size, [...new Set(stages)]) })" | tail -1
```

### Step 3: Add the test

In `src/server/built-metadata.test.ts`, find the end of the
`describe('fields the forms, lists and record producers name', ...)` block (lines 602-609, quoted
in "Current state"). Insert the new `it` between the closing `})` of the existing `it` (line 608)
and the closing `})` of the `describe` (line 609), with one blank line before it:

```ts
    /*
     * The scale scripts (tools/scale) are pasted into Scripts - Background and are no part of the build. They name
     * their fields as texts too. The dry run records each one, with the value set, while it runs both scripts.
     */
    it('are columns and choices in the scale scripts too, which the dry run runs', async () => {
        const { scaleScriptNames } = await import('../../tools/scale/dry-run.mjs')
        const { named, stages } = scaleScriptNames()
        const choicesOf = (table: string, column: string): string[] | undefined => {
            const path = join(BUILT, 'dictionary', `${table}.xml`)
            if (!existsSync(path)) return undefined
            const choices = new RegExp(`<element name="${column}" [^>]*>\\s*<choice>([\\s\\S]*?)</choice>`).exec(readFileSync(path, 'utf8'))?.[1]
            return choices === undefined ? undefined : [...choices.matchAll(/<element value="([^"]*)"/g)].map(([, value = '']) => value)
        }
        /** The platform tables the scripts name that the SDK ships no definition of: what each extends, and its own columns named. */
        const UNDEFINED: Readonly<Record<string, { parent: string; columns: readonly string[] }>> = {
            customer_account: { parent: 'core_company', columns: ['number'] },
            cmdb_hardware_product_model: { parent: 'cmdb_model', columns: [] },
        }
        const known = (table: string, column: string) =>
            hasColumn(table, column) || Boolean(UNDEFINED[table]?.columns.includes(column) || hasColumn(UNDEFINED[table]?.parent ?? '', column))
        const fields = [...new Set(named.map(({ table, field }) => `${table}.${field}`))]
        expect(fields.length).toBeGreaterThan(40)
        expect(fields.filter((name) => !known(name.split('.')[0] ?? '', name.split('.')[1] ?? ''))).toEqual([])
        const set = named.filter(({ table, field, value }) => value !== undefined && choicesOf(table, field) !== undefined)
        expect(new Set(set.map(({ table, field }) => `${table}.${field}`)).size).toBeGreaterThanOrEqual(6)
        expect(set.filter(({ table, field, value }) => !choicesOf(table, field)?.includes(String(value))).map(({ table, field, value }) => `${table}.${field} = ${value}`)).toEqual([])
        expect(stages.length).toBeGreaterThan(0)
        expect(stages.filter((stage) => !(stage in STAGE_FIELDS))).toEqual([])
    })
```

Notes on the code, so you can tell a typo from a real failure:
- The import is dynamic and inside the test on purpose. Importing `dry-run.mjs` runs its
  assertions. A failed assertion then fails this one test and not the whole file.
- A name such as `x_daas_ham_service_interval.asset.serial_number` is split on the dots. Only the
  first field (`asset`) is checked, as the existing test does for dot-walked fields.
- The run prints the `dry run ok:` line into the Vitest output. That is expected.

**Verify**: `npx vitest run src/server/built-metadata.test.ts` ends with `Tests  76 passed (76)`.

**Verify**: `npx tsc -p tsconfig.test.json --noEmit` exits 0.

**Verify**: `npx eslint tools/scale src/server/built-metadata.test.ts` exits 0.

### Step 4: Show that the test fails on a wrong name, then revert

This step edits `generate-fleet.js` three times and restores it. It proves the test; it leaves
nothing behind. Run each block and check its output before the next.

```bash
cp tools/scale/generate-fleet.js /tmp/generate-fleet.js.orig

sed -i.bak "s/'x_daas_ham_site', site/'x_daas_ham_sitex', site/" tools/scale/generate-fleet.js
npx vitest run src/server/built-metadata.test.ts -t "scale scripts" 2>&1 | grep -c "alm_hardware.x_daas_ham_sitex"
cp /tmp/generate-fleet.js.orig tools/scale/generate-fleet.js

sed -i.bak "s/'x_daas_ham_seen_source', 'nms'/'x_daas_ham_seen_source', 'snmp'/" tools/scale/generate-fleet.js
npx vitest run src/server/built-metadata.test.ts -t "scale scripts" 2>&1 | grep -c "alm_hardware.x_daas_ham_seen_source = snmp"
cp /tmp/generate-fleet.js.orig tools/scale/generate-fleet.js

sed -i.bak "s/models.length\], 'in_service')/models.length], 'in_use')/" tools/scale/generate-fleet.js
npx vitest run src/server/built-metadata.test.ts -t "scale scripts" 2>&1 | grep -c '"in_use"'
cp /tmp/generate-fleet.js.orig tools/scale/generate-fleet.js

rm -f tools/scale/generate-fleet.js.bak /tmp/generate-fleet.js.orig
git status --short tools/scale
```

**Verify**: each of the three `grep -c` lines prints a number of 1 or more (the test failed and
named the wrong text). `git status --short tools/scale` lists `tools/scale/dry-run.mjs` only. If
`generate-fleet.js` is listed, run `git checkout -- tools/scale/generate-fleet.js`.

**Verify**: `npx vitest run src/server/built-metadata.test.ts -t "scale scripts"` passes again.

### Step 5: Say in the design draft that the test exists

In `docs/research/scale-test.md`, section "The generated data", find the paragraph that starts
`Assets are made by the app's own` and ends `as the demo data's do.` After that paragraph, add a
blank line and this paragraph (wrapped at about 100 characters, as the file is):

```markdown
The scripts name their columns, choice values and the stage as texts. `npm test` runs the dry run
and holds every name to the built app (`src/server/built-metadata.test.ts`): a column that is
renamed, or a choice or stage that is dropped, fails there before a run on an instance. The values
of platform columns (an Agreement's `state`) are not checked.
```

**Verify**: `grep -c 'holds every name to the built app' docs/research/scale-test.md` prints `1`.

**Verify**: `grep -c '—' docs/research/scale-test.md` prints the same number as
`git show 805d5da:docs/research/scale-test.md | grep -c '—'` (you added no em dash).

### Step 6: Run the gate and commit

```bash
npm run check
git status --short
```

**Verify**: `npm run check` exits 0 and Vitest reports 0 failed, with one test more than before
(1805 if the count was 1804). `git status --short` lists exactly `docs/research/scale-test.md`,
`src/server/built-metadata.test.ts` and `tools/scale/dry-run.mjs` (plus `plans/` entries). If
`src/fluent/generated/keys.ts` is listed, STOP.

Commit the three files on the branch.

**Verify**: `git show --stat HEAD` lists those three files only.

## Test plan

- One new test, in `src/server/built-metadata.test.ts`, in the existing
  `describe('fields the forms, lists and record producers name', ...)` block. It covers:
  - the dry run itself (importing `dry-run.mjs` runs every assertion in it);
  - every field either script names in `setValue`, `addQuery` or a two-argument `get` is a column
    of its table or of a table it extends;
  - every value set on a choice column of the app is a choice of that column;
  - every stage handed to `newAsset` is a key of `STAGE_FIELDS`.
- Structural pattern: the `it` directly above it, and `columnChoices` in
  `describe('choices of the record producers', ...)` of the same file.
- Step 4 is the proof that it fails when it should.
- Verification: `npx vitest run src/server/built-metadata.test.ts` → 76 passed.

## Done criteria

ALL must hold:

- [ ] `node tools/scale/dry-run.mjs` prints a line starting `dry run ok:` and exits 0
- [ ] `grep -c "setValue('stage'" tools/scale/dry-run.mjs` prints `0`
- [ ] `grep -c 'export function scaleScriptNames' tools/scale/dry-run.mjs` prints `1`
- [ ] `npx vitest run src/server/built-metadata.test.ts -t "scale scripts"` reports 1 passed
- [ ] `git diff 805d5da --stat -- tools/scale/generate-fleet.js tools/scale/cleanup-fleet.js vitest.config.ts tsconfig.test.json` shows nothing from this plan
- [ ] `npm run check` exits 0
- [ ] No `*.bak` file under `tools/scale` (`ls tools/scale` lists three files)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `tools/scale/dry-run.mjs` or lines 602-609 of `src/server/built-metadata.test.ts` do not match
  the excerpts in "Current state".
- After step 3 the new test fails with a list of unknown fields or choices and you made no typo.
  Report the list. It means a script already names something the app does not have, which is the
  defect this test exists to find. Do not add the name to `UNDEFINED` to get it green, and do not
  edit `generate-fleet.js` or `cleanup-fleet.js`.
- The new test fails in `await import(...)` with an assertion from `dry-run.mjs`. The dry run is
  then broken on its own; report the assertion message.
- `npx tsc -p tsconfig.test.json --noEmit` reports an error on the `import('../../tools/scale/dry-run.mjs')`
  line. Report it. Do not add a `.d.ts` file or change a tsconfig.
- In step 4, a `grep -c` prints `0`: the test did not catch the wrong name.
- `npm run check` changes `src/fluent/generated/keys.ts`.

## Maintenance notes

- A new field in either script is checked with no further work, as long as the dry run reaches the
  line that names it. A branch the dry run never takes is not checked.
- A script that names a platform table the SDK ships no definition of fails the test until the
  table is added to `UNDEFINED` in the test, with the table it extends and its own columns named.
  Check those on an instance or in ServiceNow's documentation before adding them.
- Only the first field of a dot-walked name is checked (`asset` of `asset.serial_number`). The
  cleanup's `asset.serial_number` and `customer.name` end on platform columns the app cannot rename.
- Values of platform choice columns are not checked: `x_daas_ham_agreement.state` is
  `ast_contract`'s. If the generator starts setting install status or substatus itself, hold those
  to `STAGE_FIELDS` in the test.
- The stand-in `newAsset` in `dry-run.mjs` no longer stores the stage on the row. If a later dry
  run assertion needs the stage, read it from `stages`.
- Still unconfirmed, and for the instance run to settle: what the platform does on `setValue` of a
  missing field and on `addQuery` of a missing field from a scoped background script.
- Reviewer: check that `generate-fleet.js` and `cleanup-fleet.js` are byte-identical to the
  planned-at commit, and that the new test adds no entry to `shown()` or `hasColumn`.
