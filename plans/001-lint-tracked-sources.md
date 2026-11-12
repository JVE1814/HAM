# Plan 001: Make `npm run lint` skip everything git ignores

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1864b17..HEAD -- eslint.config.js package.json README.md .gitignore`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `1864b17`, 2026-11-12

## Why this matters

`npm run lint` runs `eslint .`, and `npm run check` (the only quality gate, there is no CI) runs lint
as its second step. ESLint's ignore list is written by hand in `eslint.config.js`. Any scratch folder
a developer or an agent leaves in the repo root gets linted, even when git ignores it. Today an
untracked `.audit/` folder (ignored through `.git/info/exclude`) gives 204 parse errors, so the gate
is red on a clean tree while `npx eslint src` is clean. The `.claude/**` entry in the list shows the
same problem was patched by hand once before.

After this plan, ESLint ignores exactly what git ignores (`.gitignore`, `.git/info/exclude`, the
user's global excludes). The next scratch folder needs no entry in the config. Source files that are
new and not yet committed are still linted.

## Current state

- `package.json`: the scripts. Not changed by this plan.

  ```json
  // package.json:18-19
          "lint": "eslint .",
          "check": "npm run typecheck && npm run lint && npm run build && npm run test"
  ```

- `eslint.config.js`: flat config. The imports and the global ignore block:

  ```js
  // eslint.config.js:1-4
  import js from '@eslint/js'
  import tseslint from 'typescript-eslint'
  import globals from 'globals'
  import nowConfig from './now.config.json' with { type: 'json' }
  ```

  ```js
  // eslint.config.js:30-42
  export default tseslint.config(
      {
          ignores: [
              'node_modules/**',
              '.claude/**',
              'dist/**',
              'target/**',
              '.now/**',
              '@types/**',
              'src/fluent/generated/**',
              'now.prebuild.mjs',
              'now.dev.mjs',
          ],
      },
  ```

- `.gitignore` (whole file): `.DS_Store`, `.now/`, `dist/`, `node_modules/`, `target/`,
  `*.tsbuildinfo`, `.jest_cache`. So four entries of the ESLint list (`node_modules`, `dist`,
  `target`, `.now`) repeat `.gitignore`. The other five (`.claude/**`, `@types/**`,
  `src/fluent/generated/**`, `now.prebuild.mjs`, `now.dev.mjs`) are not git-ignored and must stay.
- `README.md:287`: `| \`npm run lint\` | ESLint |`
- No `@eslint/compat` is installed (it provides `includeIgnoreFile`). This plan adds no dependency.
- Node is v24 here. `import.meta.dirname` needs Node 20.11 or later.

Design decision, already made (do not revisit):

- Chosen: `eslint.config.js` asks git for the ignored paths and spreads them into `ignores`. The
  command `git ls-files --others --ignored --exclude-standard --directory -z` prints one entry per
  ignored path, with a whole ignored folder collapsed to `folder/`. At the planned-at commit it
  prints `.audit/`, `.now/`, `dist/`, `node_modules/`. This was prototyped on a copy of the repo:
  `eslint .` went from 1 parse error in an ignored scratch folder to exit 0, and a real lint error
  in `src/client` still failed.
- Rejected: changing the script to `eslint src *.js *.mjs *.ts`. A new top-level source folder
  would silently never be linted, and an editor's ESLint would still flag scratch files.
- Rejected: `includeIgnoreFile` from `@eslint/compat`. It is a new dependency and reads one file,
  so it would need a second call for `.git/info/exclude` and misses global excludes.
- Rejected: adding `'.audit/**'`. That is the hand patch that already failed once.

Repo conventions that apply: comments only for a non-obvious why, written as one JSDoc line like the
others in `eslint.config.js` (see lines 6-10 and 17). 4-space indent, single quotes, no semicolons.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Lint | `npm run lint` | exit 0, no output after the npm banner |
| Lint, source only (works before this plan) | `npx eslint src` | exit 0 |
| What git ignores | `git ls-files --others --ignored --exclude-standard --directory` | one path per line |
| Typecheck | `npm run typecheck` | exit 0 |
| Full gate | `npm run check` | exit 0; 1586 tests pass |

## Scope

**In scope** (the only files you should modify):
- `eslint.config.js`
- `README.md` (line 287 only)

**Out of scope** (do NOT touch):
- `package.json`: the `lint` script stays `eslint .`.
- `.gitignore` and `.git/info/exclude`: git's ignore rules are the input, not the thing to change.
- `.audit/` or any other untracked folder you find: it is someone's working data. Do not delete,
  move or lint-fix it.
- Any lint rule or any other block of `eslint.config.js`.

## Git workflow

- Branch: `advisor/001-lint-tracked-sources`
- One commit. Subject is an imperative sentence under 72 characters in the repo's style (examples
  from `git log`: `Refuse a server module that is not a .ts file`, `Sort the fake platform's rows
  with the comparison its filters use`). Suggested: `Skip in lint whatever git ignores`. The body
  says what was wrong (a git-ignored scratch folder failed `npm run check`) and why this fix.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Record the starting point

Run `npx eslint src`.

**Verify**: exit 0. If it reports errors, STOP: the source has lint errors this plan does not own.

Run `npm run lint; echo "exit $?"` and note the result. If an ignored scratch folder with `.ts`
files exists (such as `.audit/`), it fails with parse errors. On a fresh clone it may already
pass. Either result is fine; continue.

### Step 2: Derive the ignores from git

In `eslint.config.js`, add one import after line 4 and one constant after the imports:

```js
import nowConfig from './now.config.json' with { type: 'json' }
import { execFileSync } from 'node:child_process'

/** What git ignores is no source: .gitignore, .git/info/exclude and the user's own excludes, so a scratch folder needs no entry here. */
const GIT_IGNORED = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], {
    cwd: import.meta.dirname,
    encoding: 'utf8',
})
    .split('\0')
    .filter(Boolean)
    .map((path) => (path.endsWith('/') ? `${path}**` : path))
```

Notes on the shape, all load-bearing:
- `-z` with `.split('\0')` keeps git from quoting paths with spaces or non-ASCII characters.
- `cwd: import.meta.dirname` makes the paths relative to the config file, which is what ESLint's
  `ignores` patterns are relative to, wherever ESLint is started from.
- A folder entry ends in `/` and becomes `folder/**`. A file entry is used as it is.
- No `try`/`catch`. The repo is always a git checkout; a failure here should be loud.

Then replace the global ignore block with:

```js
    {
        ignores: [
            ...GIT_IGNORED,
            '.claude/**',
            '@types/**',
            'src/fluent/generated/**',
            'now.prebuild.mjs',
            'now.dev.mjs',
        ],
    },
```

This removes the four entries `.gitignore` already covers (`node_modules/**`, `dist/**`,
`target/**`, `.now/**`) and keeps the five that git does not ignore.

**Verify**: `npm run lint; echo "exit $?"` → `exit 0`.

**Verify**: `npx eslint eslint.config.js; echo "exit $?"` → `exit 0` (the config lints itself).

### Step 3: Prove a git-ignored folder is skipped and real errors are not

`target/` is in `.gitignore` and no longer in the hand-written list, so it proves the derivation.

```bash
mkdir -p target/lint-probe && printf 'this is not @@ typescript {{{\n' > target/lint-probe/broken.ts
npm run lint; echo "exit $?"
rm -rf target
```

**Verify**: `exit 0`, and `ls target` afterwards says the folder does not exist.

```bash
printf 'const unused = 1\n' > src/client/lint-probe.ts
npm run lint; echo "exit $?"
rm src/client/lint-probe.ts
```

**Verify**: `exit 1` with one error, `'unused' is assigned a value but never used`, in
`src/client/lint-probe.ts`. This shows an untracked source file that git does not ignore is still
linted.

**Verify**: `git status --short` lists only `eslint.config.js` as modified. No `target/`, no
`lint-probe.ts`.

### Step 4: Say it in the README

In `README.md`, change line 287 from

```markdown
| `npm run lint` | ESLint |
```

to

```markdown
| `npm run lint` | ESLint, over everything git does not ignore (keep scratch files in a git-ignored folder) |
```

**Verify**: `grep -n 'npm run lint' README.md` → one line, the new text.

### Step 5: Run the full gate and commit

**Verify**: `npm run check` → exit 0, `Tests  1586 passed`. (The count is higher if other plans
landed first. Zero failures is the criterion.)

`npm run check` runs a build, which rewrites the tracked `src/fluent/generated/keys.ts`. Run
`git status --short`. If `src/fluent/generated/keys.ts` shows as modified, STOP (this plan changes
no Fluent code, so it should not change). Otherwise commit `eslint.config.js` and `README.md`.

## Test plan

No unit test is added: the behaviour is the lint command's own exit code, and step 3 exercises it
in both directions (ignored folder skipped, unignored error caught). The probes are deleted in the
same step so nothing is left behind.

## Done criteria

ALL must hold:

- [ ] `npm run lint` exits 0
- [ ] `grep -c "GIT_IGNORED" eslint.config.js` prints `2`
- [ ] `grep -cE "'(node_modules|dist|target|\.now)/\*\*'" eslint.config.js` prints `0`
- [ ] `grep -n '"lint"' package.json` still shows `"lint": "eslint .",`
- [ ] Step 3's two probes gave `exit 0` and `exit 1`, and both probe paths are gone
- [ ] `npm run check` exits 0
- [ ] `git status --short` shows no file outside `eslint.config.js`, `README.md` and `plans/README.md`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `eslint.config.js:30-42` does not match the excerpt in "Current state".
- `npx eslint src` fails before you change anything.
- `npm run lint` still fails after step 2. Report the first five error lines and the output of
  `git ls-files --others --ignored --exclude-standard --directory`. The likely cause is a scratch
  folder that is untracked but NOT git-ignored. That is correct behaviour: do not add it to the
  config, and do not edit `.gitignore` or `.git/info/exclude` yourself. Report the folder name so
  the operator can ignore or remove it.
- Loading the config throws (`git` not found, or "not a git repository"). Do not add a fallback.
- The fix appears to need a change to `package.json` or a new dependency.

## Maintenance notes

- An untracked folder that git does not ignore is still linted, on purpose: that is how a new
  source file gets linted before its first commit. Scratch work belongs in a git-ignored folder
  (add it to `.git/info/exclude` for a personal one, `.gitignore` for a shared one).
- The config now needs `git` on the PATH and a git checkout. Linting an exported tarball of the
  repo would throw at config load. If that ever becomes a real use, handle it then.
- The five hand-written entries that remain are tracked or unignored paths ESLint must skip for
  other reasons (generated keys, SDK hook scripts). Add to that list only for a path git tracks.
- Reviewer: check that the two probes in step 3 were actually run in both directions, and that
  `package.json` is untouched.
- Plans 019 and 020 depend on this plan because they use `npm run lint` and `npm run check` as
  gates.
