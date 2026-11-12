# Plan 020: Give coding agents an `AGENTS.md` that lists the gate and the traps

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1864b17..HEAD -- README.md AGENTS.md CLAUDE.md package.json eslint.config.js`
> If `README.md` changed since this plan was written, compare the "Current
> state" excerpts against the live file before proceeding. On a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-lint-tracked-sources.md
- **Category**: docs
- **Planned at**: commit `1864b17`, 2026-11-12

## Why this matters

The repo has no `AGENTS.md` or `CLAUDE.md`. A coding agent starts with nothing and has to find the
rules in the "Development" section of a 400-line `README.md`. Several of those rules are traps: a
violation builds and passes the unit tests, then fails on the instance or leaves the tree dirty.
A short `AGENTS.md` puts the gate and each trap in front of every agent in one line each and points
at the README for the detail. It restates nothing at length, so it does not drift from the README.

## Current state

- `ls AGENTS.md CLAUDE.md` → both missing. Neither is tracked.
- `README.md` "Development" is lines 282-405. The facts `AGENTS.md` points at, quoted so you can
  confirm them:

  - Line 288, the test row: "Those checks all fail once any file under `src/fluent` or
    `src/server` (tests aside) is newer than `dist/app`: run `npm run build` first, or
    `npx vitest run src/server/domain` while working on rules"
  - Lines 310-314: "`domain/` imports neither Glide nor `platform/` or `entry/`; `platform/` never
    imports `entry/`; no entry module imports another; a relative import in `src/server` names the
    `.ts` file, because the instance resolves a module by its exact path (`.now.ts` imports are
    written without it). ESLint enforces all four (`eslint.config.js`)"
  - Lines 315-317: "A test is a `*.test.ts` file beside the module it tests."
  - Lines 324-329: "`.now.ts` files are evaluated by the SDK, not run: they hold constants,
    template literals over constants and property access, and imports of constants from
    `src/server/domain` [...] but no function call, loop, spread or array element. A value the SDK
    cannot read is no build error: the record is built with `Symbol(...)` or `[object Object]` in
    it, which `built-metadata.test.ts` finds in the built output"
  - Lines 349-352: "Every stored choice value is defined once, in `domain/vocabulary.ts`"
  - Lines 367-369: "The name of a business rule, UI action, script action, notification, SLA, REST
    message or REST route fits the instance's 40 characters, which cut a longer one off unseen"
  - Lines 373-374: "Commit `src/fluent/generated/keys.ts`. Deleting Fluent code that was installed
    generates delete records; see the SDK's `fluent-overview` before removing metadata."
  - Line 376: heading "### Where a Fluent record goes"

- Other facts used, each checked at the planned-at commit:
  - `package.json:19`: `"check": "npm run typecheck && npm run lint && npm run build && npm run test"`.
  - Every Fluent record is keyed `$id: Now.ID['<name>']` (870 uses under `src/fluent`), and
    `npm run build` rewrites the tracked `src/fluent/generated/keys.ts`.
  - ATF tests are `src/fluent/<feature>/tests.now.ts`, grouped in
    `src/fluent/shared/test-suites.now.ts`. Running them needs an instance:
    `docs/verify-on-instance.md`, heading "### Running ATF" (anchor `#running-atf`).
  - `CONTEXT.md` is the glossary (heading "## Language"). `docs/adr/` holds the decisions,
    `docs/spec/` the per-phase specs, `plan.md` the full plan. `plan.md:122` says "No CI".
  - Lock names live in `src/server/domain/lock-names.ts`; their order is in
    `docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md`.
  - After plan 001, `npm run lint` skips whatever git ignores. That is why this plan depends on
    001: `AGENTS.md` names `npm run check` as the gate and tells agents where scratch files go.
- Markdown style in this repo: sentence-case headings, lines wrapped at about 100 characters, no
  em dashes, backticks around paths and commands.

Decision on `CLAUDE.md`, already made: create it with the single line `@AGENTS.md`. Claude Code
reads `CLAUDE.md`, not `AGENTS.md`, and that line imports the other file. One line cannot drift.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Lint | `npm run lint` | exit 0 (Markdown is not linted; this only shows nothing else moved) |
| Path check | the loop in step 3 | prints nothing |
| Scope check | `git status --short` | only `AGENTS.md` and `CLAUDE.md`, both `??` before the commit |

## Scope

**In scope** (the only files you should create or modify):
- `AGENTS.md` (create)
- `CLAUDE.md` (create)

**Out of scope** (do NOT touch):
- `README.md`: it stays the one full statement of the conventions. Do not move text out of it or
  add a link to `AGENTS.md`.
- `CONTEXT.md`, `docs/`, `plan.md`.
- Any source, config or test file.
- Restating a convention in more than one line. If a trap needs explaining, the README explains it.

## Git workflow

- Branch: `advisor/020-agents-md`
- One commit with both files. Subject is an imperative sentence under 72 characters in the repo's
  style (examples: `Refuse a server module that is not a .ts file`,
  `Name JOB.billingGenerate where the docs named the deleted generationJob`). Suggested:
  `Tell a coding agent the gate and the traps in AGENTS.md`. The body says an agent had to find
  them in the README's Development section, and that each line points there.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the README still says what `AGENTS.md` will point at

```bash
grep -n '^## Development\|^### Where a Fluent record goes\|^## Verify on an instance' README.md
grep -c 'Commit `src/fluent/generated/keys.ts`' README.md
grep -c 'fits the instance.s 40 characters' README.md
grep -c 'no function call, loop, spread' README.md
grep -n '^### Running ATF' docs/verify-on-instance.md
```

**Verify**: the first command prints three headings; the three counts are each `1`; the last
prints one line. If any is missing, STOP.

### Step 2: Create `AGENTS.md`

Create `AGENTS.md` in the repo root with exactly this content:

```markdown
# Working in this repo

ServiceNow scoped app `x_daas_ham`, written in ServiceNow SDK Fluent. `README.md` section
"Development" is the full statement of the conventions. This file lists the gate and the traps;
each line points at the place that explains it. Use the words of `CONTEXT.md` in names and comments.

## Gate

- `npm run check` runs typecheck, lint, build, then Vitest, in that order. It is the only gate:
  there is no CI.
- While working on rules, `npx vitest run src/server/domain` needs no build. Every other test run
  needs `npm run build` first: `src/server/built-metadata.test.ts` fails when a file under
  `src/fluent` or `src/server` is newer than `dist/app`.
- ATF tests (`src/fluent/<feature>/tests.now.ts`, suites in `src/fluent/shared/test-suites.now.ts`)
  run on an instance only: `docs/verify-on-instance.md#running-atf`. Say so when you could not run them.

## Layers (`eslint.config.js`, ADR 0003)

- `src/server/domain/` is pure: no Glide, nothing from `platform/` or `entry/`.
- `src/server/platform/` holds the Glide services and never imports `entry/`.
- `src/server/entry/` holds thin trigger adapters; no entry module imports another.
- `src/client/` imports server code from `server/domain` only.

## Traps (each builds and passes somewhere, then fails later)

- `npm run build` rewrites the tracked `src/fluent/generated/keys.ts`. Commit it with your change.
- A relative import in `src/server` names the `.ts` file (`./money.ts`). Without it the instance
  cannot load the module.
- A `.now.ts` file holds constants, template literals and imports of constants. No function call,
  loop, spread or array element: the build accepts it and writes `Symbol(...)` into the record.
- A new Fluent record takes `$id: Now.ID['<name>']`. Where it goes: README "Where a Fluent record goes".
- Deleting Fluent code that was installed generates delete records. Read the SDK's
  `fluent-overview` first.
- The name of a rule, UI action, script action, notification, SLA, REST message or route fits 40
  characters.
- A stored choice value is defined once, in `src/server/domain/vocabulary.ts`.
- A lock name goes in `src/server/domain/lock-names.ts`, in the order ADR 0013 gives.
- A test is a `*.test.ts` file beside its module and runs against `src/server/test-support/fake-glide.ts`,
  which runs no business rule, ACL or flow.
- Lint skips what git ignores, so keep scratch files in a git-ignored folder (`.git/info/exclude`).

## Where things are

- `CONTEXT.md`: the glossary. `docs/adr/`: decisions. `docs/spec/`: behaviour by phase. `plan.md`: the plan.
- `docs/verify-on-instance.md`: what only an instance can confirm.

## Commits

- Subject: an imperative sentence under 72 characters, such as `Refuse a server module that is not
  a .ts file`. Body: what was wrong and why.
- When documented behaviour changes, change the matching spec, ADR or README line in the same commit.
- Do not push or open a pull request unless asked.
```

**Verify**: `wc -l AGENTS.md` prints a number between 40 and 55.

**Verify**: `grep -c '—' AGENTS.md` prints `0`.

### Step 3: Check every path the file names exists

```bash
for p in README.md CONTEXT.md plan.md eslint.config.js docs/adr docs/spec docs/verify-on-instance.md \
  docs/adr/0003-pure-domain-core-with-glide-adapters.md \
  docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md \
  src/server/domain src/server/platform src/server/entry src/client \
  src/server/built-metadata.test.ts src/server/test-support/fake-glide.ts \
  src/server/domain/vocabulary.ts src/server/domain/lock-names.ts src/server/domain/money.ts \
  src/fluent/generated/keys.ts src/fluent/shared/test-suites.now.ts; do
  [ -e "$p" ] || echo "MISSING $p"
done
```

**Verify**: prints nothing. If a path is missing, STOP and report it. Do not edit the line to
fit: a missing path means the repo moved since this plan was written.

### Step 4: Create `CLAUDE.md`

Create `CLAUDE.md` in the repo root. Its whole content is one line and a final newline:

```markdown
@AGENTS.md
```

**Verify**: `cat CLAUDE.md` prints `@AGENTS.md` and `wc -l CLAUDE.md` prints `1`.

### Step 5: Confirm nothing else moved, and commit

**Verify**: `git status --short` prints exactly:

```text
?? AGENTS.md
?? CLAUDE.md
```

(plus `plans/` entries if the plans folder is untracked in your checkout).

**Verify**: `npm run lint` → exit 0.

Commit both files on the branch.

**Verify**: `git show --stat HEAD` lists `AGENTS.md` and `CLAUDE.md` only.

## Test plan

No code changes, so no tests. Step 1 checks the README still holds each fact, step 3 checks every
named path exists, and step 5 checks the scope.

## Done criteria

ALL must hold:

- [ ] `AGENTS.md` exists, is 40 to 55 lines, and matches the content in step 2
- [ ] `CLAUDE.md` exists and its only line is `@AGENTS.md`
- [ ] The step 3 loop prints nothing
- [ ] `git diff 1864b17 --stat -- README.md CONTEXT.md docs src` shows nothing from this plan
- [ ] `npm run lint` exits 0
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `AGENTS.md` or `CLAUDE.md` already exists. Someone wrote one; do not overwrite it.
- A check in step 1 or step 3 fails (the README or a path has changed since `1864b17`).
- Plan 001 has not landed (`grep -c GIT_IGNORED eslint.config.js` prints `0`). The last trap
  line would then be false. Report it; do not drop the line on your own.
- You find yourself wanting to explain a convention in `AGENTS.md` beyond one line, or to edit
  `README.md`.

## Maintenance notes

- `README.md` "Development" stays the source of truth. When a convention there changes or a new
  trap appears, change the one matching line in `AGENTS.md` in the same commit. Keep the file under
  about 60 lines: a trap list that grows long stops being read.
- If the layer rules in `eslint.config.js` change, the "Layers" section changes with them.
- If CI is ever added, the "Gate" section's "there is no CI" line goes.
- Reviewer: check that every line is either a pointer or one sentence, and that nothing in it
  contradicts the README lines quoted in "Current state".
