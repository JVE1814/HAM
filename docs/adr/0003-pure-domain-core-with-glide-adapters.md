# Pure domain core with Glide adapters

Business rules (lifecycle transitions, entitlement, sourcing, normalisation, in-service detection,
billing proration, ...) live in `src/server/domain/` as plain TypeScript that never imports
`@servicenow/glide`. Glide access lives in `src/server/platform/` (repositories and gateways), and
`src/server/entry/` wires platform triggers (business rules, scheduled scripts, REST) to the two.
There is no instance in the development loop, so the domain core is the only part we can test
quickly and exhaustively (Vitest); everything Glide-facing is kept thin and covered by ATF.
