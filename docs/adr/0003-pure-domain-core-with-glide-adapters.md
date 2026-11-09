# Pure domain core with Glide adapters

Business rules (lifecycle transitions, entitlement, sourcing, normalisation, in-service detection,
billing proration, ...) live in `src/server/domain/` as plain TypeScript that never imports
`@servicenow/glide`. Glide access lives in `src/server/platform/` (repositories and gateways), and
`src/server/entry/` wires platform triggers (business rules, scheduled scripts, REST) to the two.
There is no instance in the development loop, so the domain core is the only part we can test
quickly and exhaustively (Vitest); everything Glide-facing is kept thin and covered by ATF.

## Consequences

- An entry module holds only the functions its trigger calls. Each reads the trigger's inputs, calls a
  platform service or the domain, and reports the outcome in the trigger's own terms: a form message,
  an HTTP reply, an import row's state, a log line. An operation (raise or submit an Order, source it,
  ship it, complete an install) is a platform service that returns what came of it and tells the user
  nothing itself, so a form button, a job and a REST route can all run it.
- The SDK's generated wrapper passes an entry function its arguments by name, so its parameters are
  named after the platform's globals for its trigger: `current` and `previous` (business rule),
  `event` and `current` (script action), `producer` and `current` (record producer), `request` and
  `response` (REST), `current` (UI action). `src/server/built-metadata.test.ts` checks every
  function wired from Fluent.
- The layering is linted (`eslint.config.js`): the domain imports neither Glide nor the layers above
  it, platform never imports entry, and no entry module imports another (the files still listed there
  as exceptions each wait for one operation to move to a platform service).
- Decisions are covered by unit tests in `domain/`; a platform service gets a unit test, against a
  fake of `@servicenow/glide`, where one would catch a real regression.
