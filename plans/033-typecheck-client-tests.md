# Plan 033: Make `npm run typecheck` check the client tests the way the build does

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- src/client/tsconfig.json tsconfig.test.json package.json AGENTS.md`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live files before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

`npm run build` type-checks every `.ts` and `.tsx` file under `src/client`, tests included, with
the compiler options of `src/client/tsconfig.json`. `npm run typecheck` checks the same test files
with other options: it leaves them out of the client pass and checks them in `tsconfig.test.json`,
which has Node types and the default libs (`DOM.Iterable` among them). So a client test can pass
`npm run typecheck` and fail the build, which is the third step of `npm run check`. `AGENTS.md`
lists this as a trap. This plan removes the cause: the client pass of `npm run typecheck` checks
the client tests too, with the options the build uses. The trap line in `AGENTS.md` then goes.

## Current state

- `package.json:15`, the script. The second `tsc` is the client pass:

  ```json
  "typecheck": "tsc -p src/server/tsconfig.json --noEmit && tsc -p src/client/tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit",
  ```

- `src/client/tsconfig.json`, whole file (29 lines, no newline after the last brace):

  ```json
  {
      "compilerOptions": {
          "moduleResolution": "bundler",
          "module": "es2022",
          "target": "es2022",
          "lib": [
              "ES2022",
              "DOM"
          ],
          "jsx": "preserve",
          "skipLibCheck": true,
          "strict": true,
          "noEmit": true,
          "allowImportingTsExtensions": true,
          "types": [],
          "paths": {
              "@/*": [
                  "./*"
              ]
          }
      },
      "include": [
          "./**/*.ts",
          "./**/*.tsx"
      ],
      "exclude": [
          "./**/*.test.ts"
      ]
  }
  ```

  The `exclude` (lines 26-28) is what keeps the client tests out of the client pass.
- `tsconfig.test.json` (repo root) extends `src/server/tsconfig.json`, sets `"types": ["node"]`,
  and includes `src/server/**/*.ts`, `src/client/**/*.test.ts`, `src/client/global.d.ts` and
  `vitest.config.ts`. It sets no `lib`, so it has the default libs of target `es2022`, which
  include `DOM.Iterable`. **This plan does not change it**: server tests import client modules
  (`src/server/built-metadata.test.ts` imports `src/client/workspace/dashboard`), and those need
  `src/client/global.d.ts` in that program. A trial that removed the two client lines failed with
  `src/client/api.ts(25,24): error TS2339: Property 'g_ck' does not exist`.
- How the build checks client code: `node_modules/@servicenow/sdk-api/dist/util/ui-build.js`,
  function `typeCheckProject`. It reads the compiler options of `src/client/tsconfig.json`, sets
  `skipAddingFilesFromTsConfig = true` (so `include` and `exclude` are ignored), and adds
  `**/*.ts`, `**/*.tsx` and `**/*.d.ts` under the client folder. That is every client test, checked
  with `lib: ["ES2022", "DOM"]` and `types: []`.
- The gap, shown at the planned-at commit with a three-line probe
  (`const h = new Headers(); for (const [k] of h) console.log(k)`): with the default libs it
  compiles; with `--lib ES2022,DOM` it fails with
  `error TS2488: Type 'Headers' must have a '[Symbol.iterator]()' method that returns an iterator`.
- There are 14 client test files (`find src/client -name '*.test.ts' | wc -l`). At the planned-at
  commit all 14 type-check with the client options: a trial config that extends
  `src/client/tsconfig.json`, includes `./**/*.ts` and `./**/*.tsx` and excludes nothing exits 0.
- Nothing else reads the `exclude` of `src/client/tsconfig.json`. Vite bundles what the `*.html`
  entries import (`now.vite.mjs`), ESLint does not use a tsconfig (`eslint.config.js` has no
  `project` or `tsconfig` setting), and the SDK ignores it as said above.
- The `@/` alias: `src/client/tsconfig.json` maps `@/*` to `./*` (the client folder). A client test
  that imports through `@/` resolves in the client pass after this plan. It does not resolve in
  `tsconfig.test.json`, which has no `paths`. No client test uses `@/` today
  (`grep -rn "from '@/" src/client --include='*.test.ts'` prints nothing).
- The trap line this plan removes, `AGENTS.md:40-41`:

  ```markdown
  - `npm run build` type-checks `src/client/**/*.test.ts` with the libs of `src/client/tsconfig.json`,
    which have no `DOM.Iterable`. A client test can pass `npm run typecheck` and still fail the build.
  ```

- `README.md:286` describes the script as "server modules, client app and tests". That stays true.
  Do not change it.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0, no output after the three `tsc` lines |
| Client pass alone | `npx tsc -p src/client/tsconfig.json --noEmit` | exit 0 |
| Files in the client pass | `npx tsc -p src/client/tsconfig.json --noEmit --listFilesOnly \| grep -c 'src/client/.*\.test\.ts$'` | `0` before step 1, `14` after |
| Lint | `npm run lint` | exit 0 |
| Full gate | `npm run check` | exit 0 |

`npm run check` builds, and the build rewrites the tracked `src/fluent/generated/keys.ts`. This
plan changes no Fluent code, so that file must come out unchanged.

## Scope

**In scope** (the only files you should modify):
- `src/client/tsconfig.json`
- `AGENTS.md` (remove two lines)

**Out of scope** (do NOT touch):
- `tsconfig.test.json`: see "Current state" for why its client lines stay.
- `package.json`: no fourth `tsc` pass is needed. The existing client pass does the work.
- `tsconfig.json` (repo root), `src/server/tsconfig.json`, `vitest.config.ts`, `eslint.config.js`.
- Any `*.test.ts` file. If a client test fails the stricter check, that is a STOP condition.
- `README.md`.

## Git workflow

- Branch: `advisor/033-typecheck-client-tests`
- One commit with both files. Subject is an imperative sentence under 72 characters in the repo's
  style (examples: `Refuse a server module that is not a .ts file`,
  `Let the pages import the domain only, and say so in lint not in tsconfig`). Suggested:
  `Type-check the client tests with the options the build uses`. The body says the build checks
  every file under `src/client` with the client tsconfig's options and ignores its `exclude`, that
  `npm run typecheck` checked the tests with Node types and `DOM.Iterable` only, and that the
  `AGENTS.md` trap is gone with its cause.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the starting point

```bash
npm run typecheck
npx tsc -p src/client/tsconfig.json --noEmit --listFilesOnly | grep -c 'src/client/.*\.test\.ts$'
find src/client -name '*.test.ts' | wc -l
grep -c 'skipAddingFilesFromTsConfig = true' node_modules/@servicenow/sdk-api/dist/util/ui-build.js
grep -c 'DOM.Iterable' AGENTS.md
```

**Verify**: the first command exits 0. The second prints `0`. The third prints `14` (a higher
number is fine if tests were added; note it as N). The fourth prints `1`. The fifth prints `1`.
If the fourth prints `0`, STOP: the SDK no longer checks client code this way.

### Step 2: Remove the `exclude` from `src/client/tsconfig.json`

Change the end of the file from

```json
    "include": [
        "./**/*.ts",
        "./**/*.tsx"
    ],
    "exclude": [
        "./**/*.test.ts"
    ]
}
```

to

```json
    "include": [
        "./**/*.ts",
        "./**/*.tsx"
    ]
}
```

Change nothing else in the file. Keep the 4-space indent.

**Verify**: `grep -c exclude src/client/tsconfig.json` prints `0`.

**Verify**: `npx tsc -p src/client/tsconfig.json --noEmit --listFilesOnly | grep -c 'src/client/.*\.test\.ts$'`
prints `14` (or the N from step 1).

**Verify**: `npx tsc -p src/client/tsconfig.json --noEmit` exits 0 and prints no error. If it
prints an error in a `*.test.ts` file, STOP and report the error. Do not edit the test.

### Step 3: Show that the client pass now catches what the build catches

This step writes a probe file and deletes it again. It proves the change; it leaves nothing behind.

```bash
printf "const h = new Headers()\nfor (const [k] of h) console.log(k)\nexport {}\n" > src/client/zz-probe.test.ts
npx tsc -p src/client/tsconfig.json --noEmit; echo "exit $?"
rm src/client/zz-probe.test.ts
git status --short
```

**Verify**: the `tsc` line prints
`src/client/zz-probe.test.ts(2,19): error TS2488: Type 'Headers' must have a '[Symbol.iterator]()' method that returns an iterator.`
and `exit 2`. `git status --short` lists `src/client/tsconfig.json` only (plus `plans/` entries if
that folder is untracked in your checkout). If `zz-probe.test.ts` is still listed, delete it.

### Step 4: Remove the trap line from `AGENTS.md`

Delete these two lines (40-41) from `AGENTS.md`, and nothing else:

```markdown
- `npm run build` type-checks `src/client/**/*.test.ts` with the libs of `src/client/tsconfig.json`,
  which have no `DOM.Iterable`. A client test can pass `npm run typecheck` and still fail the build.
```

The line before them ends `which runs no business rule, ACL or flow.` and the line after starts
`- Lint skips what git ignores`. Those two lines are now next to each other.

**Verify**: `grep -c 'DOM.Iterable' AGENTS.md` prints `0`.

**Verify**: `git diff --stat AGENTS.md` shows `2 deletions(-)` and no insertion.

### Step 5: Run the gate and commit

```bash
npm run check
git status --short
```

**Verify**: `npm run check` exits 0. Vitest reports 0 failed. `git status --short` lists exactly
`AGENTS.md` and `src/client/tsconfig.json` (plus `plans/`). If `src/fluent/generated/keys.ts` is
listed, STOP: this plan changes no Fluent code.

Commit the two files on the branch.

**Verify**: `git show --stat HEAD` lists `AGENTS.md` and `src/client/tsconfig.json` only.

## Test plan

No new test file. Step 3 is the test of the change: a probe that the build would refuse is refused
by `npm run typecheck`'s client pass, and is then deleted. The existing 14 client tests passing the
client pass (step 2) shows the stricter check costs nothing today.

## Done criteria

ALL must hold:

- [ ] `grep -c exclude src/client/tsconfig.json` prints `0`
- [ ] `npx tsc -p src/client/tsconfig.json --noEmit --listFilesOnly | grep -c 'src/client/.*\.test\.ts$'` equals `find src/client -name '*.test.ts' | wc -l`
- [ ] `npm run typecheck` exits 0
- [ ] `grep -c 'DOM.Iterable' AGENTS.md` prints `0`
- [ ] `ls src/client/zz-probe.test.ts` says no such file
- [ ] `npm run check` exits 0
- [ ] `git diff 805d5da --stat -- tsconfig.test.json package.json src/fluent` shows nothing from this plan
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `src/client/tsconfig.json` does not match the excerpt in "Current state".
- Step 1's `grep` for `skipAddingFilesFromTsConfig` prints `0`. The SDK changed how it checks
  client code, and the premise of this plan must be read again.
- A client test fails the client pass in step 2. Report the file and the error. The fix belongs in
  that test, and it is not this plan's to make.
- The probe in step 3 compiles (exit 0). The client pass then does not use the options this plan
  assumes.
- You find yourself adding `"types": ["node"]` or `DOM.Iterable` to `src/client/tsconfig.json` to
  get a test green. The build uses that file's options, so loosening them changes what the pages
  are compiled against.
- `npm run build` fails in step 5 with `Type check failed!` while `npm run typecheck` passed. The
  two checks still differ; report the build's error.

## Maintenance notes

- A client test is now checked twice by `npm run typecheck`: by the client pass (the build's
  options) and by `tsconfig.test.json` (Node types, default libs). The client pass is the stricter
  one for browser APIs. `tsconfig.test.json` is the one with Node types, so a client test that
  needs `node:fs` or `process` passes there and fails the client pass and the build. That is the
  build's rule, now seen one step earlier.
- If the SDK starts honouring `exclude` in `src/client/tsconfig.json`, the build stops checking
  client tests and this plan's change is still harmless.
- A client test that imports through the `@/` alias passes the client pass and fails
  `tsconfig.test.json`, which has no `paths`. If one is ever written, give `tsconfig.test.json` the
  same `paths` entry (`"@/*": ["./src/client/*"]`) in that change.
- Reviewer: check that the diff of `src/client/tsconfig.json` removes the `exclude` block and
  nothing else, and that `AGENTS.md` lost exactly the two trap lines.
