# Plan 028: Find an Agreement's Sites for attestation with one grouped count, not by reading every Asset

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- src/server/platform/attestations.ts src/server/platform/attestations.test.ts src/server/platform/records.ts src/server/test-support/fake-glide.ts docs/adr/0007-chunked-jobs-with-persistent-cursors.md`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition. (Plan 038 edits the bullet directly
> above the one this plan edits in ADR 0007. That alone is not a mismatch if
> the *Attestations* bullet still reads as quoted below.)

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

The daily attestation job needs one thing from the hardware table: the distinct Sites where an
attesting Agreement has equipment in use. Today it gets them by reading every in-use fleet asset
of the Agreement, one row at a time, with no limit, and collecting the Site of each. The app is
built for 100k to 1M Assets (ADR 0007). An Agreement with 50,000 Assets at 200 Sites costs 50,000
row reads a day to learn 200 values, inside one scheduled transaction that holds the job's run
lock, which is taken as abandoned after 10 minutes.

The database can answer the question directly. One aggregate query grouped by Site returns one row
per Site. The app already has the helper (`countBy`) and already runs the same kind of query on the
same table. After this plan the job reads one row per Site, opens the same attestations, and
ADR 0007 says so.

## Current state

### The job

`src/server/platform/attestations.ts` holds the job. `raiseDueAttestations` (line 42) takes the run
lock and calls `raiseHolding`, which does the work:

```ts
// src/server/platform/attestations.ts:48-69
/** The run, holding its `lock`. One that outlasts it (ADR 0013) opens no attestation once it has lost it. */
function raiseHolding(lock: HeldLock): void {
    const today = todayIso()
    const agreement = new GlideRecord('x_daas_ham_agreement')
    agreement.addEncodedQuery(ACTIVE_AGREEMENTS)
    agreement.addQuery('attestation_interval_months', '>', 0)
    agreement.query()
    while (agreement.next()) {
        const sites = new Set<string>()
        const asset = new GlideRecord('alm_hardware')
        asset.addEncodedQuery(fleetStagesQuery(IN_USE_STAGES, `x_daas_ham_agreement=${agreement.getUniqueValue()}`))
        asset.query()
        while (asset.next()) if (str(asset, 'x_daas_ham_site')) sites.add(str(asset, 'x_daas_ham_site'))
        for (const siteId of sites) {
            if (exists(ATTESTATION, `site=${siteId}^${OPEN_ATTESTATIONS}`)) continue
            const last = lastAttestedOn(siteId)
            if (!attestationDue({ lastAttestedOn: last, intervalMonths: num(agreement, 'attestation_interval_months'), today })) continue
            if (!lock.held()) return void log.warn('Attestation run stopped, its lock lost: the run that took it over raises the rest')
            openAttestation(agreement, siteId)
        }
    }
}
```

Lines 56 to 60 are the finding: a `GlideRecord` over `alm_hardware` with no `setLimit`, read to the
end, to fill a `Set` of Site sys_ids. An Asset with no Site is left out (`if (str(...))`).

The import of the record helpers, which this plan extends by one name:

```ts
// src/server/platform/attestations.ts:12
import { bool, exists, findById, num, refusal, str, warnRefused } from './records.ts'
```

### The helper to use

```ts
// src/server/platform/records.ts:101-111
/** How many records match an encoded query for each value of `field` (one aggregate query); values with none are left out. */
export function countBy(table: string, encodedQuery: string, field: string): Map<string, number> {
    const ga = new GlideAggregate(table)
    ga.addEncodedQuery(encodedQuery)
    ga.addAggregate('COUNT', '')
    ga.groupBy(field)
    ga.query()
    const counts = new Map<string, number>()
    while (ga.next()) counts.set(String(ga.getValue(field) ?? ''), Number(ga.getAggregate('COUNT', '')))
    return counts
}
```

Two facts about it matter here:

- The Assets with no Site form one group, whose key is the empty string `''`. The job must skip
  that key, as it skips an Asset with no Site today.
- The keys of the `Map` are distinct, so a Site is visited once however the database returns its
  groups.

### Why the same query is safe in an aggregate

`fleetStagesQuery(IN_USE_STAGES, base)` (`src/server/domain/fleet.ts:61`) builds an encoded query
with one clause per stage, joined by `^NQ`, each clause carrying `base` and the fleet condition.
The app already runs a `fleetStagesQuery` through a grouped `GlideAggregate` on `alm_hardware`:

```ts
// src/server/platform/spare-pools.ts:70-75
function deployedShares(ratios: ReadonlyMap<string, number>): DeployedShare[] {
    const ga = new GlideAggregate('alm_hardware')
    ga.addEncodedQuery(fleetStagesQuery(DEPLOYED_STAGES, `x_daas_ham_agreementIN${[...ratios.keys()].join(',')}`))
    ga.addAggregate('COUNT', '')
    ga.groupBy('x_daas_ham_agreement')
    ga.groupBy('model')
```

and `countBy` itself is called with a `^NQ` query at `src/server/platform/spare-pools.ts:98`. So
this plan adds no new kind of query. `alm_hardware` has an index on `x_daas_ham_agreement` and one
on `x_daas_ham_site` (`src/fluent/shared/platform-tables.now.ts:89-91`).

### The test stand-in supports it

Platform tests run against `src/server/test-support/fake-glide.ts`. Its `GlideAggregate`
(lines 365 to 406) knows `COUNT`, `groupBy`, `addEncodedQuery` and `getValue` of a group-by field,
which is all `countBy` uses. It evaluates the query with the same evaluator as `GlideRecord`, so
the operators of `fleetStagesQuery` are already covered by the existing tests of this job. It
returns the groups in the order their first row is stored, which is the order the `Set` was filled
in before, so the existing tests see the same order of Sites.

### The existing tests

`src/server/platform/attestations.test.ts` has 3 tests, all through `raiseDueAttestations`:

- `opens one attestation for a Site never attested, listing its installed Assets, and lets its run lock go`
  proves one Asset at one Site gives one attestation, and a second run opens none.
- `opens nothing while another run holds its lock, and says so`.
- `opens no further attestation once it has lost its lock` has two Assets at two Sites and proves
  the Sites are visited in order (`site1` first).

None has two Assets at one Site, an Asset with no Site, or a second Agreement. This plan adds two
tests for those. Its helper for an Asset row is:

```ts
// src/server/platform/attestations.test.ts:16-20
/** A fleet asset in service at a Site, under the attesting Agreement ag1. */
function installed(id: string, siteId: string): Row {
    const { installStatus, substatus } = fieldsOf('in_service')
    return { sys_id: id, x_daas_ham_fleet: 'true', x_daas_ham_agreement: 'ag1', x_daas_ham_site: siteId, install_status: installStatus, substatus: substatus ?? '' }
}
```

### The decision not to batch the two per-Site queries

For each Site the job runs two more queries: `exists(ATTESTATION, ...)` (line 62) and
`lastAttestedOn(siteId)` (line 63, defined at lines 71 to 79). Both stay as they are. Reasons:

- Each reads at most one row (`setLimit(1)`), so their cost grows with the number of Sites, not
  with the number of Assets. The finding is the read that grows with Assets.
- Batching `lastAttestedOn` needs the latest `attested_at` per Site, a `MAX` aggregate. The test
  stand-in knows only `COUNT` and `SUM` (`fake-glide.ts:360-363`) and throws on any other. Teaching
  it `MAX` is a change to shared test support, outside a small plan.
- `lastAttestedOn` is skipped for a Site with an open attestation. A batch would read it for every
  Site.

### Documentation to change

ADR 0007 describes how each job bounds its work. Its bullet for this job states the behaviour this
plan removes:

```md
<!-- docs/adr/0007-chunked-jobs-with-persistent-cursors.md:47-49 -->
- Attestations (`platform/attestations.ts` `raiseDueAttestations`) read every in-service or
  temporarily deployed fleet asset of each active Agreement with an attestation interval, in one run
  with no time budget or cursor.
```

`docs/spec/p2-assurance.md` (lines 43 to 49) says which Sites get an attestation and when. It does
not say how the Sites are found, and the Sites do not change, so it needs no edit.

### Conventions that apply (README.md "Development", AGENTS.md)

- A test is a `*.test.ts` file beside the module it tests. A platform test mocks Glide with
  `vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)`.
  The fake throws `fake Glide: ...` on anything it does not know. It runs no business rule.
- A relative import in `src/server` names the `.ts` file (`./records.ts`). ESLint enforces it.
- `npx vitest run <path>` needs no build. `npm test` and `npm run check` do: the tests in
  `src/server/built-metadata.test.ts` fail when a file under `src/server` is newer than `dist/app`.
- `npm run build` rewrites the tracked file `src/fluent/generated/keys.ts`. This plan changes no
  Fluent file, so the build must leave it unchanged.
- Comments only for a non-obvious why. Use the words of `CONTEXT.md`: Asset, Site, Agreement.
- When documented behaviour changes, the matching doc line changes in the same commit.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| This plan's tests | `npx vitest run src/server/platform/attestations.test.ts` | all pass |
| Build | `npm run build` | exit 0; rewrites `dist/` |
| Full gate | `npm run check` | exit 0; all tests pass |

## Scope

**In scope** (the only files you should modify):

- `src/server/platform/attestations.ts` (only `raiseHolding` and the import on line 12)
- `src/server/platform/attestations.test.ts` (two tests added)
- `docs/adr/0007-chunked-jobs-with-persistent-cursors.md` (the *Attestations* bullet only)

**Out of scope** (do NOT touch, even though they look related):

- `src/server/platform/records.ts`. `countBy` is right as it is.
- `src/server/test-support/fake-glide.ts`. It already supports what `countBy` uses.
- `exists(...)`, `lastAttestedOn` and `openAttestation` in `attestations.ts`. See "The decision not
  to batch the two per-Site queries".
- `src/server/platform/installed-assets.ts`. `openAttestation` lists a Site's Assets through it.
  That read is needed: the attestation has one item per Asset.
- A time budget or a cursor for this job. ADR 0007 records that it has none. Adding one is a
  different change.
- The *Scheduled returns* bullet of ADR 0007 (lines 44 to 46). Plan 038 owns it.
- Any `src/fluent` file.

## Git workflow

- Branch: `advisor/028-attestation-sites-by-aggregate`, from `main`.
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example
  `Find the Sites to attest with one grouped count per Agreement`. The body says what was wrong and
  why (every in-use Asset of the Agreement was read to learn its Sites).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Branch and confirm the baseline

```sh
git checkout main && git checkout -b advisor/028-attestation-sites-by-aggregate
npx vitest run src/server/platform/attestations.test.ts
```

**Verify**: 3 passed, 0 failed (more passed only if another plan added tests to this file).

### Step 2: Add the two tests that pin which Sites are attested

In `src/server/platform/attestations.test.ts`, insert these two tests inside
`describe('the daily attestation run', ...)`, directly after the first test (the one that ends with
`expect(rows(LOCKS)).toEqual([])` at line 39 and its closing `})` at line 40) and before
`it('opens nothing while another run holds its lock, and says so', ...)`. Keep one blank line
between tests.

```ts
    it('opens one attestation for a Site with several Assets, and none for an Asset at no Site', () => {
        rows('alm_hardware').push(installed('a2', 'site1'), installed('a3', ''))

        raiseDueAttestations()

        expect(rows(ATTESTATIONS).map((attestation) => attestation.site)).toEqual(['site1'])
        expect(rows(ITEMS).map((item) => item.asset)).toEqual(['a1', 'a2'])
    })

    it('opens an attestation for each Site of the Agreement, and none for a Site of an Agreement that attests nothing', () => {
        rows('x_daas_ham_agreement').push({ sys_id: 'ag2', state: 'active', attestation_interval_months: '0', customer: 'acme' })
        rows('alm_hardware').push(installed('a2', 'site2'), { ...installed('a3', 'site3'), x_daas_ham_agreement: 'ag2' })

        raiseDueAttestations()

        expect(rows(ATTESTATIONS).map((attestation) => attestation.site)).toEqual(['site1', 'site2'])
    })
```

Add no import. Every name used is already in the file.

These tests describe behaviour the job already has. They must pass before the code changes and
after it. That is the point: they prove the change keeps the same set of Sites.

**Verify**: `npx vitest run src/server/platform/attestations.test.ts` → 5 passed, 0 failed. If
either new test fails now, STOP: the job does not behave as this plan assumes.

### Step 3: Read the Sites with one grouped count

Edit `src/server/platform/attestations.ts`.

On line 12, add `countBy` to the import, keeping the names in alphabetical order:

```ts
import { bool, countBy, exists, findById, num, refusal, str, warnRefused } from './records.ts'
```

In `raiseHolding`, replace these six lines (lines 56 to 61):

```ts
        const sites = new Set<string>()
        const asset = new GlideRecord('alm_hardware')
        asset.addEncodedQuery(fleetStagesQuery(IN_USE_STAGES, `x_daas_ham_agreement=${agreement.getUniqueValue()}`))
        asset.query()
        while (asset.next()) if (str(asset, 'x_daas_ham_site')) sites.add(str(asset, 'x_daas_ham_site'))
        for (const siteId of sites) {
```

with these four:

```ts
        // One grouped count gives the Sites, however many Assets each has: no Asset row is read.
        const inUse = fleetStagesQuery(IN_USE_STAGES, `x_daas_ham_agreement=${agreement.getUniqueValue()}`)
        for (const siteId of countBy('alm_hardware', inUse, 'x_daas_ham_site').keys()) {
            if (!siteId) continue
```

Change nothing else. The body of the `for` loop (the `exists` check, `lastAttestedOn`,
`attestationDue`, the lost-lock check and `openAttestation`) stays as it is, and so do the closing
braces. `GlideRecord` and `str` are still used elsewhere in the file, so their imports stay.

**Verify**:

- `npx vitest run src/server/platform/attestations.test.ts` → 5 passed, 0 failed.
- `grep -c "new GlideRecord('alm_hardware')" src/server/platform/attestations.ts` → `0`.
- `grep -c "countBy('alm_hardware', inUse, 'x_daas_ham_site')" src/server/platform/attestations.ts` → `1`.
- `npm run typecheck` → exit 0. `npm run lint` → exit 0.

### Step 4: Update ADR 0007

In `docs/adr/0007-chunked-jobs-with-persistent-cursors.md`, replace the three lines of the
*Attestations* bullet (quoted under "Documentation to change") with:

```md
- Attestations (`platform/attestations.ts` `raiseDueAttestations`) read the Sites of each active
  Agreement with an attestation interval with one count of its in-service or temporarily deployed
  fleet assets grouped by Site, so no Asset row is read, then check each Site for an open
  attestation and its last one, in one run with no time budget or cursor.
```

Leave the bullets above and below it as they are.

**Verify**: `grep -c "grouped by Site, so no Asset row is read" docs/adr/0007-chunked-jobs-with-persistent-cursors.md`
→ `1`, and `grep -c "read every in-service or" docs/adr/0007-chunked-jobs-with-persistent-cursors.md` → `0`.

### Step 5: Run the full gate and commit

```sh
npm run check
git status --short
```

**Verify**: `npm run check` exits 0 (1806 tests passed at the planned-at commit, 2 more than
before; more if other plans landed). `git status --short` lists only the three in-scope files. If
`src/fluent/generated/keys.ts` shows as modified, see the STOP conditions.

Commit the three files in one commit, with the subject from "Git workflow" and a body that says
what was wrong and why.

## Test plan

- `src/server/platform/attestations.test.ts`, modelled on the tests already in that file (same
  `beforeEach`, same `installed` helper). Two tests added:
  - two Assets at one Site and one Asset with no Site give exactly one attestation, at that Site,
    listing the two Assets. This is the case the grouped count must get right: one group per Site,
    and the group of Assets with no Site skipped;
  - two Sites of the attesting Agreement each get an attestation, and a Site whose only Asset
    belongs to an Agreement with no attestation interval gets none. This holds the per-Agreement
    condition of the query.
- The 3 existing tests stay unchanged and must pass. `opens no further attestation once it has
  lost its lock` also holds the order in which the Sites are visited.
- Verification: `npx vitest run src/server/platform/attestations.test.ts` → 5 passed.

What the tests cannot show: the fake reads rows in memory, so they do not measure the saving. The
grep in step 3 shows that the row-by-row read is gone. That the platform's `GlideAggregate` accepts
this query rests on `spare-pools.ts`, which already runs the same kind of query.

ATF: no ATF test covers this job's read. Nothing to run on an instance for this plan. Say in your
report that no instance check was run.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npx vitest run src/server/platform/attestations.test.ts` reports 5 passed, 0 failed
- [ ] `npm run check` exits 0
- [ ] `grep -c "new GlideRecord('alm_hardware')" src/server/platform/attestations.ts` prints `0`
- [ ] `grep -c "countBy('alm_hardware', inUse, 'x_daas_ham_site')" src/server/platform/attestations.ts` prints `1`
- [ ] `grep -c "read every in-service or" docs/adr/0007-chunked-jobs-with-persistent-cursors.md` prints `0`
- [ ] `git diff --stat main..HEAD -- src/fluent` prints nothing
- [ ] `git status --short` is empty and only the three in-scope files differ from `main`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts.
- A new test of step 2 fails before the code change. The job then opens a different set of
  attestations than this plan assumes, and the change cannot be shown to keep it.
- A test fails with a message that starts with `fake Glide:`. Report the message. Do not extend
  `fake-glide.ts` under this plan.
- `opens no further attestation once it has lost its lock` fails after step 3. The Sites are then
  visited in another order than before. Report it. Do not sort the keys to make it pass.
- `countBy` in `records.ts` no longer has the signature `(table, encodedQuery, field)` or no longer
  returns a `Map` keyed by the group value.
- You find yourself wanting to batch `exists` or `lastAttestedOn`, or to add a `MAX` aggregate to
  the fake. That is out of scope.
- `npm run build` leaves `src/fluent/generated/keys.ts` modified. Report the diff.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The job still runs two small queries per Site and has no time budget. If the number of Sites of
  one Agreement ever reaches the tens of thousands, the next step is a cursor (ADR 0007), not a
  wider aggregate.
- If `lastAttestedOn` is ever batched, `fake-glide.ts` needs a `MAX` aggregate first, with the
  platform's behaviour for an empty group.
- The Sites come back in the database's group order, where they came back in the order of the
  Asset query before. The order decides only which Sites are reached before a run loses its lock.
  The next run opens the rest.
- A reviewer should check two things: the `''` key is skipped (an Asset with no Site must open no
  attestation), and the query passed to `countBy` is the same `fleetStagesQuery(IN_USE_STAGES, ...)`
  as before.
- Plan 038 edits the neighbouring *Scheduled returns* bullet of ADR 0007. The two edits do not
  overlap, but they touch adjacent lines, so the second one to land may need a trivial rebase.
