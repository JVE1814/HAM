# Working in this repo

ServiceNow scoped app `x_daas_ham`, written in ServiceNow SDK Fluent. `README.md` section
"Development" is the full statement of the conventions. This file lists the gate and the traps;
each line points at the place that explains it. Use the words of `CONTEXT.md` in names and comments.

## Gate

- `npm run check` runs typecheck, lint, build, then Vitest, in that order. It is the only gate:
  there is no CI.
- `npm test` needs `npm run build` first: `src/server/built-metadata.test.ts` fails when a file
  under `src/fluent` or `src/server` (tests aside) is newer than `dist/app`. A run without that
  file, such as `npx vitest run src/server/domain`, needs no build.
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
- A test is a `*.test.ts` file beside its module. A test of `platform/` or `entry/` runs against
  `src/server/test-support/fake-glide.ts`, which runs no business rule, ACL or flow.
- Lint skips what git ignores, so keep scratch files in a git-ignored folder (`.git/info/exclude`).

## Where things are

- `CONTEXT.md`: the glossary. `docs/adr/`: decisions. `docs/spec/`: behaviour by phase. `plan.md`: the plan.
- `docs/verify-on-instance.md`: what only an instance can confirm.

## Commits

- Subject: an imperative sentence under 72 characters, such as `Refuse a server module that is not
  a .ts file`. Body: what was wrong and why.
- When documented behaviour changes, change the matching spec, ADR or README line in the same commit.
- Do not push or open a pull request unless asked.
