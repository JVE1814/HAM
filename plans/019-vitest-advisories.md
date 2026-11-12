# Plan 019: Move Vitest to 4.1.12 so its three advisories and tinypool's two are gone

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1864b17..HEAD -- package.json package-lock.json vitest.config.ts tsconfig.test.json`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition. (A changed `package-lock.json` alone
> is not a mismatch if `npm ls vitest` still prints `vitest@3.x`.)

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-lint-tracked-sources.md
- **Category**: migration
- **Planned at**: commit `1864b17`, 2026-11-12

## Why this matters

`npm audit` reports two critical and several moderate advisories in the test runner: Vitest 3.2.4,
its `@vitest/mocker`, and `tinypool`. They affect developer machines (the Vitest dev server in watch
or UI mode), not the installed ServiceNow app. No 3.x release clears them: `@vitest/mocker` is fixed
only from 4.1.12 and `tinypool` only from 2.1.2, which Vitest 3 cannot use. Vitest 4.1.12 clears
all five and drops `tinypool` altogether. The upgrade was trialled on a copy of the repo at the
planned-at commit: no config or test change was needed and all 1586 tests passed.

## Current state

- `package.json:38`: `"vitest": "^3.2.4"` (in `devDependencies`). Installed: `vitest@3.2.4`,
  `@vitest/mocker@3.2.4`, `tinypool@1.1.1`, `vite-node@3.2.4`, `vite@7.3.8`.
- `package.json:16-17`: `"test": "vitest run"`, `"test:watch": "vitest"`.
- `vitest.config.ts` (whole file, needs no change):

  ```ts
  import { defineConfig } from 'vitest/config'

  export default defineConfig({
      test: {
          include: ['src/server/**/*.test.ts', 'src/client/**/*.test.ts'],
          environment: 'node',
      },
  })
  ```

- Vitest API the tests use (94 files import from `'vitest'`): `describe`/`it`/`expect`/
  `beforeAll`/`beforeEach`/`afterEach`, `vi.mock` (33 uses, mostly
  `vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)`),
  `vi.fn` (3), `vi.stubGlobal` (2), `vi.unstubAllGlobals` (1), `vi.hoisted` (1), `vi.mocked` (1).
  No workspace file, no coverage config, no custom pool options, no reporters.
- The advisories, with the ranges `npm audit --json` gave on 2026-11-12:

  | Package | Advisory | Severity | Vulnerable range |
  |---|---|---|---|
  | vitest | GHSA-5xrq-8626-4rwp | critical | `<3.2.6` |
  | @vitest/mocker | GHSA-82fw-gwwq-j7x9 | moderate | `>=2.1.0 <4.1.11` |
  | @vitest/mocker | GHSA-qxg6-89mg-rqv8 | moderate | `>=2.1.0-beta.7 <4.1.12` |
  | tinypool | GHSA-5gmw-xhrv-c9v3 | critical | `<=2.1.0` |
  | tinypool | GHSA-85c8-ppgw-ccpr | critical | `<2.1.2` |

  So 4.1.12 is the lowest Vitest that clears all of them. It is the head of the `V4` dist-tag.
  `latest` is 5.1.0, which this plan does not use (untested here, and a second major jump).
- Vitest 4.1.12 requires `vite ^6 || ^7 || ^8` (repo has 7.3.8), Node `^20 || ^22 || >=24`
  (machine has v24.22), `@types/node ^20 || ^22 || >=24` (repo has `^22.18.0`). All satisfied.
- Audit totals at the planned-at commit: 33 vulnerabilities (3 low, 19 moderate, 9 high,
  2 critical). In the trial after the upgrade: 30 (3 low, 18 moderate, 9 high, 0 critical).
- `src/server/built-metadata.test.ts` fails with `dist/app is older than package.json` once
  `package.json` changes. That is expected. `npm run build` clears it.
- `npm install` prints `install-scripts ... blocked because they are not covered by allowScripts`
  for five packages. That warning is there before this plan too. Ignore it.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Installed versions | `npm ls vitest @vitest/mocker tinypool vite-node` | see steps |
| Upgrade | `npm install -D vitest@^4.1.12` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 (needs plan 001; before it, use `npx eslint src`) |
| Build | `npm run build` | `Build completed successfully` (TS210 warnings are normal) |
| Tests | `npx vitest run` | `Test Files  94 passed`, `Tests  1586 passed` at `1864b17` |
| Full gate | `npm run check` | exit 0 |
| Audit | `npm audit` | exits non-zero (other packages remain); see step 4 for the check |

## Suggested executor toolkit

- Vitest's migration guide, only if a test fails after the upgrade:
  `https://vitest.dev/guide/migration.html` (section for 3 to 4).

## Scope

**In scope** (the only files you should modify):
- `package.json` (the `vitest` line only)
- `package-lock.json` (rewritten by npm)

**Out of scope** (do NOT touch):
- `npm audit fix` and `npm audit fix --force`. They change other packages. `--force` downgrades
  `@servicenow/sdk` to 4.12.2 and `shadcn` to 1.0.0, which breaks the app.
- The remaining advisories (undici, zod, joi, fast-xml-parser, glob, minimatch, deepmerge). They
  come through `@servicenow/sdk`, `@servicenow/isomorphic-rollup`, `shadcn` and
  `typescript-eslint`. Their only fix today is an SDK downgrade. Leave them.
- `vite`, `typescript`, `@types/node` or any other dependency version.
- `vitest.config.ts` and every test file, unless a STOP condition sends you back for instructions.
- Vitest 5.x.

## Git workflow

- Branch: `advisor/019-vitest-advisories`
- One commit with `package.json` and `package-lock.json`. Subject is an imperative sentence under
  72 characters in the repo's style (examples: `Refuse a server module that is not a .ts file`,
  `Match a reference qualifier's javascript: prefix in the regex that reads its literal`).
  Suggested: `Move Vitest to 4.1.12, past its and tinypool's advisories`. The body names the five
  GHSA ids and says no 3.x release clears them.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the starting point

Run `npm ls vitest tinypool @vitest/mocker`.

**Verify**: it prints `vitest@3.2.4` (or another 3.x), with `@vitest/mocker` and `tinypool` under
it. If it already prints `vitest@4.1.12` or later, STOP: the work is done already.

Run `npm run build && npx vitest run`.

**Verify**: `Build completed successfully`, then zero failed tests. Note the two totals
(`Test Files  N passed`, `Tests  M passed`). At `1864b17` they are 94 and 1586.

### Step 2: Check the advisories still point at 4.1.12

```bash
npm audit --json | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const v=JSON.parse(s).vulnerabilities;for(const n of ['vitest','@vitest/mocker','tinypool'])for(const a of (v[n]?.via??[]))if(typeof a==='object')console.log(n,a.url,a.range)})"
```

**Verify**: every printed range for `vitest` and `@vitest/mocker` ends below or at `<4.1.12`
(the table in "Current state"). If a range now reaches past 4.1.12 (for example `<4.1.13` or
`<=5.0.2`), STOP and report the line: the target version in this plan is out of date.

### Step 3: Upgrade

```bash
npm install -D vitest@^4.1.12
```

**Verify**: `grep -n '"vitest"' package.json` → `"vitest": "^4.1.12"`.

**Verify**: `npm ls vitest tinypool @vitest/mocker vite-node` prints `vitest@4.1.x` with
`@vitest/mocker@4.1.x` (x is 12 or higher) and no `tinypool` and no `vite-node` line.

**Verify**: `git status --short` lists exactly `package.json` and `package-lock.json`.

**Verify**: `git diff package.json` shows one changed line, the `vitest` version.

### Step 4: Confirm the advisories are gone

```bash
npm audit --json | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const d=JSON.parse(s);console.log(['vitest','@vitest/mocker','tinypool'].filter(n=>n in d.vulnerabilities),d.metadata.vulnerabilities.critical)})"
```

**Verify**: prints `[] 0` (no entry for the three packages, zero criticals). If the list is not
empty, STOP. If the list is empty but the critical count is not 0, continue and report which
package the new critical is in (`npm audit | grep -B3 critical`): it is not this plan's.

### Step 5: Run the gate

```bash
npm run check
```

It runs typecheck, lint, build, then Vitest. The build is needed: `package.json` changed, so
`built-metadata.test.ts` would otherwise fail with `dist/app is older than package.json`.

**Verify**: exit 0. The Vitest banner says `RUN  v4.1.12` (or a later 4.1.x). `Test Files` and
`Tests` totals equal the ones you noted in step 1, with 0 failed and 0 skipped.

**Verify**: `git status --short` still lists only `package.json` and `package-lock.json`. If
`src/fluent/generated/keys.ts` is modified, STOP (this plan changes no Fluent code).

### Step 6: Commit

Commit the two files on the branch.

**Verify**: `git show --stat HEAD` lists `package.json` and `package-lock.json` only.

## Test plan

No new tests. The existing suite is the test: the same number of files and tests must pass on
Vitest 4 as on Vitest 3 (step 1 against step 5). A drop in the test count with no failure means
Vitest 4 is not collecting some files, which is a STOP condition.

## Done criteria

ALL must hold:

- [ ] `grep -n '"vitest"' package.json` shows `^4.1.12`
- [ ] `npm ls tinypool` prints `(empty)`
- [ ] The step 4 command prints `[] 0` (or `[]` with a reported, unrelated critical)
- [ ] `npm run check` exits 0 with the same test totals as before the upgrade
- [ ] `git diff 1864b17 --stat -- vitest.config.ts src` shows nothing from this plan
- [ ] Only `package.json`, `package-lock.json` and `plans/README.md` are modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `npm install` fails or reports an `ERESOLVE` peer conflict. Do not pass `--force` or
  `--legacy-peer-deps`.
- `npm install` changes any line of `package.json` other than `vitest`.
- Any test fails or is skipped under Vitest 4 after `npm run build`, or the totals differ from
  step 1. Report the failing file and the first error. Do not edit tests or `vitest.config.ts` to
  get it green: in the trial nothing needed changing, so a failure means the repo has moved.
- `npm run typecheck` fails in a `*.test.ts` file or in `vitest.config.ts` (a Vitest type changed).
- Step 2 shows an advisory range that reaches past 4.1.12.
- Clearing the advisories appears to need Vitest 5 or a change to `vite`.

## Maintenance notes

- Vitest 4 no longer uses `tinypool` or `vite-node`. If a later change adds pool options,
  coverage or a workspace file, write it against the Vitest 4 docs: several of those options moved
  or were renamed between 3 and 4.
- The timing line of the Vitest summary now says `import` where 3.x said `collect`. Nothing reads it.
- Nine high advisories remain, all through `@servicenow/sdk` and its build chain. They clear when
  ServiceNow ships an SDK that updates undici, zod and joi. Re-run `npm audit` after each SDK bump.
- Vitest 5 is `latest`. Moving to it is a separate decision. Nothing in the audit asks for it today.
- Reviewer: check the lockfile diff contains only Vitest's own tree (`vitest`, `@vitest/*`,
  removed `tinypool`/`vite-node`/`chai`-era packages, a few small utilities), and no change to
  `@servicenow/*`, `vite` or `typescript`.
