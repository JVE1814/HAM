# Plan 005: Keep a requested site decommission to the units its requester may see

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1864b17..HEAD -- src/server/platform/installed-assets.ts src/server/platform/returns.ts src/server/platform/returns.test.ts docs/adr/0005-visibility-by-before-query-rules.md docs/spec/p2-aftersales.md`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-lint-tracked-sources.md
- **Category**: security
- **Planned at**: commit `1864b17`, 2026-11-12

## Why this matters

A Customer admin can ask on the customer page for a whole Site to be decommissioned. The server
then reads every fleet asset at that Site, in the admin's session, and puts each on the Return.
That read is a query with one `^NQ` clause per lifecycle stage. The before-query visibility rule
appends the admin's `company=<their Customer>` filter to the query, and the platform binds an
appended condition to the last `^NQ` clause only. The last clause is the *temporary deployment*
stage, so units in the other three stages are read with no Customer filter. A fleet asset at the
Site whose `company` is another Customer, or blank, lands on the admin's Return and becomes
*pending return*. That needs inconsistent data, but ADR 0005 names this case and says how such a
read must be written, and this read does not follow it.

After this plan, the decommission read carries the requester's visibility filter in every clause,
as the customer page's equipment list already does. A Customer admin's decommission returns what
their page shows them at the Site. Staff, who see every Customer, get the same list as today.

## Current state

Files and their roles:

- `src/server/platform/returns.ts`. `requestReturn` and `raiseRequested` raise the Return a user requests from the customer page or the record producer.
- `src/server/platform/installed-assets.ts`. `installedAssetIds` lists fleet assets by Site, Agreement, or Order. Scheduled jobs, audits, and attestations call it too.
- `src/server/platform/visibility.ts`. `visibleQuery` puts the signed-in user's filter into each `^NQ` clause.
- `src/server/platform/customer-page.ts`. `customerEquipment` is the existing use of `visibleQuery` to copy.
- `src/server/platform/returns.test.ts`. Tests on the in-memory Glide fake (5 tests today).
- `docs/adr/0005-visibility-by-before-query-rules.md`, `docs/spec/p2-aftersales.md`. The documented behaviour.

The decommission read, made in the requester's session:

```ts
// src/server/platform/returns.ts:297-303
function raiseRequested(request: RequestedEquipment, site: GlideRecord | null): RequestOutcome {
    const { produced, customerId, siteId } = request
    const trigger = requestedTrigger(request.decommission)
    const requested = isSiteRecovery(trigger) ? installedAssetIds({ siteId, stages: stagesTakenBack(trigger) }) : fleetAssetsAt(siteId, request.listedAssetIds)
    if (!produced && requested.length === 0) {
        return notRaised('nothing', request.decommission ? 'The site has no installed devices' : "Choose at least one of the site's devices")
    }
```

`raiseRequested` is reached only through `requestReturn` (`returns.ts:287-295`). The customer page
route calls that as a Customer admin (`src/server/entry/customer.ts:96`), and the record producer
calls it as the signed-in user who filled the producer in (`requestProducedReturn`,
`returns.ts:328-340`).

The query it runs has no visibility filter of its own:

```ts
// src/server/platform/installed-assets.ts:7-13
interface InstalledFilter {
    agreementId?: string
    siteId?: string
    orderId?: string
    /** The stages listed: a Return passes those it takes back (domain/returns `stagesTakenBack`). */
    stages?: readonly Stage[]
}
```

```ts
// src/server/platform/installed-assets.ts:34-46
function queryInstalled(filter: InstalledFilter): GlideRecord {
    const base = [
        filter.agreementId ? `x_daas_ham_agreement=${filter.agreementId}` : '',
        filter.siteId ? `x_daas_ham_site=${filter.siteId}` : '',
        filter.orderId ? `x_daas_ham_order_line.order=${filter.orderId}` : '',
    ]
        .filter(Boolean)
        .join('^')
    const asset = new GlideRecord('alm_hardware')
    asset.addEncodedQuery(fleetStagesQuery(filter.stages ?? INSTALLED_STAGES, base))
    asset.query()
    return asset
}
```

`fleetStagesQuery` (`src/server/domain/fleet.ts:61-63`) builds one clause per stage, joined with
`^NQ` (`stagesQuery`, `src/server/domain/lifecycle.ts:288-296`). A decommission takes back
`SERVING_STAGES` (`lifecycle.ts:53`): shipped, pending in service, in service, temporary deployment.

The helper that ADR 0005 prescribes, and its existing use:

```ts
// src/server/platform/visibility.ts:10-20
/**
 * `query` on `table` kept to what the signed-in user may see: their visibility filter is ANDed into each of its `^NQ`
 * clauses. The table's before-query rule appends the same filter, which an `^NQ` binds to the last clause only, and a
 * server read meets no read ACL to remove the rest (ADR 0005), so a query with `^NQ` clauses that must stay within the
 * reader's view runs through this.
 */
export function visibleQuery(table: ScopedTable, query: string): string {
    const session = currentSession()
    const filter = visibilityFilter(session.scope, SCOPED_TABLES[table], session)
    return filter ? andEachClause(query, filter) : query
}
```

```ts
// src/server/platform/customer-page.ts:34-35
    const asset = new GlideRecord('alm_hardware')
    asset.addEncodedQuery(visibleQuery('alm_hardware', fleetStagesQuery(DEPLOYED_STAGES)))
```

For a Customer admin the filter on `alm_hardware` is `company=<their Customer>`
(`src/server/domain/visibility.ts:163-170`). For staff and for a job running as system the filter
is null, and `visibleQuery` returns the query unchanged.

The decision this plan must stay consistent with:

```md
<!-- docs/adr/0005-visibility-by-before-query-rules.md:137-139 -->
- A server script's GlideRecord is not checked by ACLs. A read the app makes for a restricted user and returns to them,
  if it has `^NQ` clauses, carries the user's filter in each clause itself: it runs through `platform/visibility`
  `visibleQuery`, which ANDs the reader's `visibilityFilter` into each clause (the customer page's equipment).
```

The test fixture you extend. Note that `unit()` sets no `company`:

```ts
// src/server/platform/returns.test.ts:17-20
function unit(stage: Stage): Row {
    const { installStatus, substatus } = fieldsOf(stage)
    return { sys_id: 'a1', serial_number: 'FOC111', x_daas_ham_fleet: 'true', x_daas_ham_site: 'site1', x_daas_ham_agreement: 'ag1', install_status: installStatus, substatus: substatus ?? '' }
}
```

Repo conventions that apply (README.md "Development"):

- A relative import in `src/server` names the `.ts` file, for example `'./visibility.ts'`.
- `platform/` may import `domain/` and other `platform/` modules. It never imports `entry/`.
- A platform test runs against `src/server/test-support/fake-glide.ts`. The fake runs no business rule, so in a test only `visibleQuery` narrows a read. The fake throws when a `^NQ` query is combined with a second condition (`fake-glide.ts:201-204`), so the filter must go into the one encoded query.
- `platform/session.ts:25-27` remembers a user's scope and Customer by user id for as long as the module lives, which in a test file is the whole file. The new tests therefore sign in as the same user `u1` of Customer `acme` that the neighbouring `describe` uses.
- When documented behaviour changes, the matching spec and ADR lines change in the same commit.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 (needs plan 001; before it, use `npx eslint src`) |
| One test file | `npx vitest run <path>` | all pass |
| Build | `npm run build` | exit 0, rewrites `dist/` |
| Full gate | `npm run check` | exit 0; typecheck, lint, build, then all tests |

`src/server/built-metadata.test.ts` fails when a file under `src/server` is newer than `dist/app`.
Run `npm run build` (or `npm run check`, which builds) before a full `npx vitest run`.

## Scope

**In scope** (the only files you should modify):

- `src/server/platform/installed-assets.ts`
- `src/server/platform/returns.ts` (the call in `raiseRequested` and the doc comment of `requestReturn` only)
- `src/server/platform/returns.test.ts`
- `docs/adr/0005-visibility-by-before-query-rules.md` (lines 137-139 only)
- `docs/spec/p2-aftersales.md` (the bullet at lines 113-116 only)

**Out of scope** (do NOT touch, even though they look related):

- The other callers of `installedAssetIds` and `installedAssetIdsBySite`: `src/server/platform/scheduled-returns.ts:45,88,92`, `src/server/platform/attestations.ts:79`, `src/server/platform/audits.ts:98`. They keep today's query. Do not make `visibleQuery` the default in `queryInstalled`. Those callers run in jobs or in staff sessions, and this plan did not examine what a filter would do to their lists.
- `fleetAssetsAt` in `returns.ts` (the device-removal path). It reads each listed asset by sys_id, and the visibility rule applies to such a read.
- `src/server/entry/customer.ts`. The route does not change. Plan 010 edits it.
- `src/server/platform/visibility.ts` and `src/server/domain/visibility.ts`. The filter is correct.
- `src/fluent/**`. No metadata changes.

## Git workflow

- Branch: `advisor/005-decommission-visible-query`
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example `Keep a decommission to the units its requester may see`. Existing examples: `Refuse a server module that is not a .ts file`, `Hold BROAD_STAFF to PROVIDER_STAFF but the inventory tech`. The body says what was wrong and why.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing test

Append this `describe` block to the end of `src/server/platform/returns.test.ts`. It uses the
file's existing imports and helpers (`unit`, `rows`, `requestReturn`, `RETURNS`, `RETURN_LINES`,
`RETURN_LINE_STATUS`). Add no import.

```ts
describe("a Customer admin's site decommission", () => {
    beforeEach(() => {
        platform.user = { id: 'u1', name: 'Ada', company: 'acme', roles: ['x_daas_ham.customer_admin'], interactive: true }
        platform.creatable = () => true
        platform.defaults[RETURN_LINES] = () => ({ status: RETURN_LINE_STATUS.awaiting })
        platform.references = { [`${RETURN_LINES}.return_order`]: RETURNS, [`${RETURNS}.agreement`]: 'x_daas_ham_agreement' }
        platform.tables.cmn_location = [{ sys_id: 'site1', name: 'HQ', company: 'acme', x_daas_ham_is_site: 'true' }]
        platform.tables.x_daas_ham_agreement = [{ sys_id: 'ag1', overdue_return_days: '10' }]
    })

    const decommission = () => requestReturn({ customerId: 'acme', siteId: 'site1', decommission: true, listedAssetIds: [], method: 'ship_back', describe: (site) => `Decommission of ${site}` })
    const returning = (): string[] => rows(RETURN_LINES).map((line) => line.asset)

    it("takes back the Customer's own units at the Site, in every stage it recovers", () => {
        platform.tables.alm_hardware = [
            { ...unit('in_service'), sys_id: 'a1', company: 'acme' },
            { ...unit('shipped'), sys_id: 'a2', company: 'acme' },
        ]
        expect(decommission()).toEqual({ raised: true, number: 'RET0002', lines: 2 })
        expect(returning().sort()).toEqual(['a1', 'a2'])
    })

    it("leaves a unit at the Site that is another Customer's, or no Customer's, off the Return, whatever its stage", () => {
        platform.tables.alm_hardware = [
            { ...unit('in_service'), sys_id: 'a1', company: 'acme' },
            { ...unit('shipped'), sys_id: 'b1', company: 'other' },
            { ...unit('in_service'), sys_id: 'b2', company: 'other' },
            { ...unit('in_service'), sys_id: 'b3', company: '' },
        ]
        expect(decommission()).toEqual({ raised: true, number: 'RET0002', lines: 1 })
        expect(returning()).toEqual(['a1'])
    })
})
```

**Verify**: `npx vitest run src/server/platform/returns.test.ts` → 6 pass, 1 fail. The failing test
is `leaves a unit at the Site that is another Customer's, or no Customer's, off the Return, whatever its stage`.
It fails on the first `expect` because the Return has 4 lines. The first new test passes on today's
code. It pins the behaviour that must not change.

### Step 2: Let the installed-assets read carry the reader's filter, and ask for it in the decommission

In `src/server/platform/installed-assets.ts`:

1. Add the import after the `./records.ts` import on line 5:

    ```ts
    import { visibleQuery } from './visibility.ts'
    ```

2. Add one optional field to `InstalledFilter`, after `stages`:

    ```ts
        /**
         * Keep the list to what the signed-in user may see (platform/visibility `visibleQuery`, ADR 0005): for a read made
         * for a restricted user, whose before-query rule narrows the last `^NQ` clause of the stages only.
         */
        visibleToReader?: boolean
    ```

3. In `queryInstalled`, replace the two lines that create the record and add the query with:

    ```ts
        const installed = fleetStagesQuery(filter.stages ?? INSTALLED_STAGES, base)
        const asset = new GlideRecord('alm_hardware')
        asset.addEncodedQuery(filter.visibleToReader ? visibleQuery('alm_hardware', installed) : installed)
    ```

    Keep `asset.query()` and `return asset` after them. Call `addEncodedQuery` once. A second call would add the filter to the last clause only, which is the bug.

In `src/server/platform/returns.ts`, replace line 300 (the `const requested = ...` line shown in
"Current state") with:

```ts
    const requested = isSiteRecovery(trigger)
        ? installedAssetIds({ siteId, stages: stagesTakenBack(trigger), visibleToReader: true })
        : fleetAssetsAt(siteId, request.listedAssetIds)
```

**Verify**:

- `npx vitest run src/server/platform/returns.test.ts` → 7 tests pass.
- `npx vitest run src/server/platform` → all pass, including `scheduled-returns.test.ts`, `audits.test.ts`, and `customer-page.test.ts`.
- `npm run typecheck` → exit 0.

### Step 3: Update the comment, the ADR, and the spec

1. In `src/server/platform/returns.ts`, in the doc comment of `requestReturn`, replace these four lines (273-276):

    ```ts
     * before the Site's devices are read. A site decommission returns everything installed or shipped at the Site
     * (domain/returns `stagesTakenBack`); a device removal the listed fleet assets (ADR 0016) deployed at the Site,
     * as a list qualified in the browser, or sent to the API, may name any Asset. The Return runs under the Agreement of
     * its first Asset unless the produced Return order names one.
    ```

    with:

    ```ts
     * before the Site's devices are read. A site decommission returns everything installed or shipped at the Site
     * (domain/returns `stagesTakenBack`) that the requester may see (platform/installed-assets `visibleToReader`, ADR
     * 0005): a Customer admin's leaves a unit of another Customer, or of none, at the Site where it is. A device removal
     * returns the listed fleet assets (ADR 0016) deployed at the Site, as a list qualified in the browser, or sent to
     * the API, may name any Asset. The Return runs under the Agreement of its first Asset unless the produced Return
     * order names one.
    ```

2. In `docs/adr/0005-visibility-by-before-query-rules.md`, line 139, replace

    ```md
      `visibleQuery`, which ANDs the reader's `visibilityFilter` into each clause (the customer page's equipment).
    ```

    with:

    ```md
      `visibleQuery`, which ANDs the reader's `visibilityFilter` into each clause (the customer page's equipment, and
      the units a requested site decommission takes back, `platform/installed-assets` `visibleToReader`).
    ```

3. In `docs/spec/p2-aftersales.md`, the bullet at lines 113-116 reads:

    ```md
    - A site decommission returns everything installed at the Site (in service, temporary, pending in
      service), whatever devices the request lists. From the record producer and the customer page it
      also returns units still shipped to the Site (`domain/returns.ts` `stagesTakenBack`), so none
      is left holding the site package open.
    ```

    Append these sentences to the same bullet, wrapped at about 100 characters like the lines above:

    ```md
      A requested decommission returns the units its requester may see: the read carries their
      visibility filter in each stage's clause (`platform/visibility` `visibleQuery`, ADR 0005). A
      Customer admin's decommission therefore leaves a unit at the Site whose company is another
      Customer's, or blank (a data gap), off the Return. Staff see every Customer and return
      everything at the Site.
    ```

**Verify**: `grep -n "visibleToReader" src/server/platform/returns.ts docs/adr/0005-visibility-by-before-query-rules.md` → two matches in `returns.ts` (the comment and the call) and one in the ADR. `grep -n "visibleQuery" docs/spec/p2-aftersales.md` → one match.

### Step 4: Run the gate and commit

Run `npm run check`.

**Verify**: exit 0. The test summary shows no failed test. The count is the count before this plan
plus 2 (1588 when this plan runs directly on `1864b17` with plan 001).

Then run `git status --short`. Expect exactly the five in-scope files. This plan adds no server
module, so `src/fluent/generated/keys.ts` should be unchanged.

Commit the five files with the subject from "Git workflow".

## Test plan

- `src/server/platform/returns.test.ts` gains one `describe` with 2 tests (5 tests become 7). The structural pattern is the `describe("a Customer admin's device removal", ...)` block at line 63 of the same file.
  - A decommission takes the Customer's own units in two of the stages it recovers. This passes before and after.
  - A decommission leaves off a shipped unit and an in-service unit of another Customer, and a unit with no company. This is the regression test. It fails before step 2.
- These tests run on the fake, which applies no before-query rule. They prove the query itself carries the filter in every clause. They do not prove how the platform joins `^NQ` with a rule's condition. ADR 0005 and `platform/visibility.ts` already record that platform behaviour.
- Existing ATF, on an instance only: the test *NaaS - customer returns: admins only, own sites only, a decommission takes the whole site* (`src/fluent/returns/tests.now.ts:123`) decommissions a Site with two in-service units whose `company` is the admin's Customer (`tests.now.ts:165-194`). It must still pass. No ATF test changes.
- Verification: `npx vitest run src/server/platform/returns.test.ts` → 7 pass.

## Done criteria

Local criteria. These suffice to hand the work back.

- [ ] `npm run check` exits 0
- [ ] `npx vitest run src/server/platform/returns.test.ts` → 7 tests pass
- [ ] `grep -c "addEncodedQuery" src/server/platform/installed-assets.ts` → `1`
- [ ] `grep -rn "visibleToReader: true" src/server` → exactly one match, in `src/server/platform/returns.ts`
- [ ] `git status --short` lists only the five in-scope files, all committed
- [ ] `plans/README.md` status row updated

Instance criterion, only when an instance is at hand (see `docs/verify-on-instance.md#running-atf`):

- [ ] ATF suite **NaaS - P2** passes, including *NaaS - customer returns: admins only, own sites only, a decommission takes the whole site*

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts.
- Step 1's run does not give exactly one failure, in the named test. If both new tests pass, the read is already filtered.
- After step 2 a test in `scheduled-returns.test.ts`, `audits.test.ts`, or any file other than `returns.test.ts` changes its result. Only the requested decommission may change. Check that `visibleToReader` is optional and set in one place.
- The fake throws `a ^NQ query is combined with other conditions`. You added the filter with a second query call. Put it through `visibleQuery` into the one encoded query. If the error persists, stop.
- A step's verification fails twice after a reasonable fix attempt.
- The fix seems to need a change in `visibility.ts`, `entry/customer.ts`, or any file under `src/fluent`.
- On an instance, the ATF test named above fails after this change.

## Maintenance notes

- Overlap with plan 010 (`plans/010-customer-route-array-caps.md`). Both plans change the customer return-request path, which runs from `requestCustomerReturn` in `src/server/entry/customer.ts` into `requestReturn` in `src/server/platform/returns.ts`. This plan edits `returns.ts` line 300 and `installed-assets.ts`. Plan 010 edits `entry/customer.ts` and adds `src/server/entry/customer.test.ts`. No file is edited by both, so either order rebases without a conflict and neither plan's drift check lists the other's files. Plan 010's entry test seeds its asset with `company: 'acme'` for user `u1` of `acme`. A decommission test added to that file later needs the same, because after this plan a unit without the requester's company is left off.
- Plans 008 and 009 edit other functions of `returns.ts` (`chaseOverdue`, `settleReceivedLine`). If one lands first, this plan's drift check reports `returns.ts`. Compare only the `raiseRequested` and `requestReturn` excerpts.
- A unit at a Site with a blank or foreign `company` is now invisible to the Customer's decommission, as it already is on their equipment page. It stays in service and billed until staff return it through the record producer, which sees every Customer. Reconciliation is the place to flag such a unit.
- The other callers of `installedAssetIds` still run the unfiltered query. They run in scheduled jobs or in staff sessions (*Start site audit* is for asset managers and field techs, `src/fluent/assurance/logic.now.ts:30`). Whether any of their lists should follow the reader's view is a separate decision and was left out on purpose.
- A reviewer should check that `queryInstalled` calls `addEncodedQuery` once, and that no caller other than `raiseRequested` passes `visibleToReader`.
