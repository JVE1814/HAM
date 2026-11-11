# Pure domain core with Glide adapters

## Status

Accepted. Amended on 2026-11-11: a trigger no longer has to go through `src/server/entry/`. Fluent
wires a platform function directly when an entry function would only forward the call.

## Decision

Business rules (lifecycle transitions, entitlement, sourcing, normalisation, in-service detection,
billing proration, ...) live in `src/server/domain/` as plain TypeScript that never imports
`@servicenow/glide`. Glide access lives in `src/server/platform/` (repositories and gateways), which
also holds the operations. `src/server/entry/` holds the adapters for the platform triggers
(business rules, scheduled scripts, REST) that have something to read from the trigger or something
to report back in its terms.
There is no instance in the development loop, so the domain core is the only part we can test
quickly and exhaustively (Vitest). Of the Glide-facing code, `entry/` is kept thin and `platform/`
holds the operations, covered by ATF and, where a fake of Glide catches a real regression, by unit
tests.

The first version of this decision put every trigger behind an entry function. About a third of
those functions only called one platform function with the same arguments. Such a function gave the
operation a second name and a second module to open, and added nothing a test could check. So a
trigger with nothing to read and nothing to word is wired to the platform function itself.

## Consequences

- An entry module holds only the functions that adapt a trigger. Each reads the trigger's inputs,
  calls a platform service or the domain, and reports the outcome in the trigger's own terms: a form
  message, an HTTP reply, an import row's state, a log line. An entry function that would only
  forward is not written: the Fluent record names the platform function.
- An operation (raise or submit an Order, source it, ship it, complete an install) is a platform
  service that returns what came of it and tells the user nothing itself, so a form button, a job
  and a REST route can all run it.
- Fluent imports a function from `entry/` or `platform/` only to wire it to a record. It imports
  constants from `domain/` and `platform/` as before.
- The SDK's generated wrapper passes a wired function its arguments by name, wherever the function
  lives. So its parameters are named after the platform's globals for its trigger: `current` and
  `previous` (business rule), `event` and `current` (script action), `producer` and `current`
  (record producer), `request` and `response` (REST), `current` (UI action). A platform function
  wired directly follows the same rule, and most such functions (the scheduled jobs) take no
  argument. `src/server/built-metadata.test.ts` checks every function wired from Fluent.
- A business rule's condition loads its module by the installed path, which
  `src/fluent/shared/server-modules.now.ts` builds. The functions conditions call stay in `entry/`.
- The layering is linted (`eslint.config.js`), type-only imports included: the domain imports neither
  Glide nor the layers above it, platform never imports entry, and no entry module imports another.
- Decisions are covered by unit tests in `domain/`; a platform service gets a unit test, against a
  fake of `@servicenow/glide`, where one would catch a real regression.
