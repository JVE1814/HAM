# Plan 002: Refuse a replacement for a failed asset that is not the case account's

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1864b17..HEAD -- src/server/domain/breakfix.ts src/server/domain/breakfix.test.ts src/server/platform/breakfix.ts src/server/platform/breakfix.test.ts docs/spec/p2-aftersales.md`
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

A CSM case names a failed asset. **Raise replacement** on the case creates a device-replace Order
for the Customer and the Site of that asset, and never compares them with the case's account. A
case for Customer A can therefore name a fleet asset of Customer B. The field's reference qualifier
only filters the picker in the browser, so a list edit, an import, or a script sets any asset. The
Order is then raised at B's Site. When its replacement is installed, `retireReplacedAssets`
(`src/server/platform/delivery.ts:233-248`) puts B's working unit on a Return and its billing stops.

After this plan, a case that names an account takes nothing from another Customer's asset, and
**Raise replacement** refuses it and says why. A case with no account still takes the asset's
Customer, as the spec says.

## Current state

Files and their roles:

- `src/server/domain/breakfix.ts`. Pure rules for break-fix. `replacementProblem` says why no Order is raised.
- `src/server/domain/breakfix.test.ts`. Its unit tests (7 tests today).
- `src/server/platform/breakfix.ts`. Glide service. `takeFailedAssetTerms` is the before rule on the case. `raiseReplacement` is the form button.
- `src/server/platform/breakfix.test.ts`. Does not exist. You create it.
- `src/server/entry/breakfix.ts`. Shows the `why` of a `not_raised` outcome to the user. Not changed.
- `src/fluent/break-fix/break-fix.now.ts`. Wires the rule and the button. Not changed.
- `docs/spec/p2-aftersales.md`. The spec lines for break-fix.

The pure rule today:

```ts
// src/server/domain/breakfix.ts:21-29
/**
 * Why "Raise replacement" raises no Order for the case's failed Asset, or null when it does: only a fleet asset (ADR
 * 0016) installed at a Site is replaced like-for-like.
 */
export function replacementProblem(failed: { fleet: boolean; stage: Stage | null }): string | null {
    if (!failed.fleet) return 'Only a fleet asset is replaced: the failed asset is not one'
    if (failed.stage === null || !INSTALLED_STAGES.includes(failed.stage)) return 'Only installed assets can be replaced'
    return null
}
```

The before rule keeps an account that is already set, whatever the asset's Customer is, and still
takes the service level from the asset's Agreement:

```ts
// src/server/platform/breakfix.ts:28-38
/**
 * Before insert/update rule on cases naming a failed Asset (br_case_failed_asset), wired here: the case takes its
 * customer and service level from the Asset. A failed asset outside the fleet (ADR 0016), set by a script past the
 * field's reference qualifier, gives the case nothing. `current` is the rule's case, which the platform saves.
 */
export function takeFailedAssetTerms(current: ForeignRecord): void {
    const asset = findById('alm_hardware', str(current, 'x_daas_ham_failed_asset'))
    if (!asset || !isFleetAsset(asset)) return
    current.setValue('x_daas_ham_replacement_tier', str(asset, 'x_daas_ham_agreement.replacement_tier'))
    if (!str(current, 'account')) current.setValue('account', str(asset, 'company'))
}
```

The button builds the Order from the asset alone:

```ts
// src/server/platform/breakfix.ts:61-76
    const failed = findById('alm_hardware', str(kase, 'x_daas_ham_failed_asset'))
    if (!failed) return notRaised('Set the failed asset on the case first')
    const problem = replacementProblem({ fleet: isFleetAsset(failed), stage: readStage(failed) })
    if (problem) return notRaised(problem)
    const raised = createOrder(
        {
            orderType: 'device_replace',
            customerId: str(failed, 'company'),
            siteId: str(failed, 'x_daas_ham_site'),
            agreementId: str(failed, 'x_daas_ham_agreement'),
            installMode: 'fsm_engineer',
            caseId: kase.getUniqueValue(),
            shortDescription: `Replace ${str(failed, 'asset_tag') || str(failed, 'serial_number')} (${str(kase, 'number')})`,
        },
        [{ modelId: str(failed, 'model'), quantity: 1, replacesAssetId: failed.getUniqueValue() }],
    )
```

The case field has only a browser-side qualifier:

```ts
// src/fluent/shared/platform-tables.now.ts:169-173
        x_daas_ham_failed_asset: ReferenceColumn({
            label: 'Failed asset',
            referenceTable: 'alm_hardware',
            referenceQual: FLEET_CONDITION,
        }),
```

The spec today:

```md
<!-- docs/spec/p2-aftersales.md:8-11 -->
- A CSM case names the **failed asset**, a fleet asset (the field offers fleet assets only). The case
  takes the Agreement's replacement service level and the Asset's Customer. A failed asset outside the
  fleet, set past the field's qualifier by a script, gives the case neither, and **Raise replacement**
  refuses it (*Only a fleet asset is replaced*).
```

Design constraints you must honor:

- The case's `account` and the asset's `company` hold the same kind of sys_id. ADR 0006
  (`docs/adr/0006-company-field-holds-the-customer.md`) says: "On Assets, `company` is the Customer
  (a CSM account)". The existing rule already copies `company` into `account`, and
  `openFaultCase` (`src/server/platform/customer-page.ts:135`) does the same for a fault reported
  from the customer page. So the two values are compared as plain strings.
- The rule on the case must not refuse the save. `sn_customerservice_case` belongs to another scope.
  `docs/research/external-contracts.md:1364-1367` says: "No other rule refuses a save on another
  scope's table: the before rule on `sn_customerservice_case` (`platform/breakfix.ts`
  takeFailedAssetTerms) and the lease rule and transfer release rule on `alm_hardware` [...] only set
  fields". `takeFailedAssetTerms` takes a `ForeignRecord`, a type without `setAbortAction`. So this
  plan makes the rule give the case nothing on a mismatch, as it does for an asset outside the fleet,
  and makes the button refuse.
- Repo conventions (README.md "Development"):
  - `domain/` imports neither Glide nor `platform/` or `entry/`. The mismatch decision is pure and goes in `domain/breakfix.ts`.
  - A relative import in `src/server` names the `.ts` file (`'../domain/breakfix.ts'`). Domain test files import their module without it (`'./breakfix'`), as `src/server/domain/breakfix.test.ts:2` does. Follow the file you edit.
  - A test is a `*.test.ts` file beside the module it tests. A platform test runs against `src/server/test-support/fake-glide.ts`. The fake runs no business rule, ACL, or flow.
  - Comments say a non-obvious why only. Use the glossary words Customer, Asset, Order, Site with capitals, as the surrounding comments do.

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

- `src/server/domain/breakfix.ts`
- `src/server/domain/breakfix.test.ts`
- `src/server/platform/breakfix.ts`
- `src/server/platform/breakfix.test.ts` (create)
- `docs/spec/p2-aftersales.md` (lines 8-11 only)

**Out of scope** (do NOT touch, even though they look related):

- `src/fluent/**`. No new business rule, Abort action, ACL, or qualifier. A field write ACL on a CSM case column is platform-owned ground and is not part of this fix.
- `src/server/entry/breakfix.ts`. It already shows `why` with `gs.addErrorMessage`.
- `src/server/platform/customer-page.ts` `openFaultCase`. It sets the account from the asset, so its cases never mismatch.
- `src/server/platform/orders.ts`, `src/server/platform/delivery.ts`. The Order and the Return logic are correct once no wrong Order is raised.
- Clearing a service level the case took from an earlier failed asset. The rule does not clear it for an asset outside the fleet today either.

## Git workflow

- Branch: `advisor/002-breakfix-account-check`
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example `Refuse a replacement for another Customer's failed asset`. Existing examples: `Refuse a server module that is not a .ts file`, `Hold BROAD_STAFF to PROVIDER_STAFF but the inventory tech`. The body says what was wrong and why.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing platform test

Create `src/server/platform/breakfix.test.ts` with exactly this content. It follows the structure of
`src/server/platform/orders.test.ts` (the `vi.mock` line, `platform.reset()` in `beforeEach`, rows
seeded in `platform.tables`).

```ts
import type { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fieldsOf } from '../domain/lifecycle.ts'
import { raiseReplacement, takeFailedAssetTerms } from './breakfix.ts'
import { findById, type ForeignRecord } from './records.ts'
import { platform, recordOf, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const CASES = 'sn_customerservice_case'
const ORDERS = 'x_daas_ham_order'
const ASSETS = 'alm_hardware'
const OTHER_CUSTOMERS = "The failed asset is not the case account's: set the account or the failed asset right first"

const rows = (table: string): Row[] => platform.tables[table] ?? []

function failedUnit(company: string): Row {
    const { installStatus, substatus } = fieldsOf('in_service')
    return {
        sys_id: 'asset1',
        serial_number: 'FOC111',
        x_daas_ham_fleet: 'true',
        company,
        x_daas_ham_site: 'site1',
        x_daas_ham_agreement: 'agr1',
        model: 'model1',
        install_status: installStatus,
        substatus: substatus ?? '',
    }
}

function storedCase(): GlideRecord {
    const found = findById(CASES, 'case1')
    if (!found) throw new Error('the case is not stored')
    return found
}

/** The case as the before rule is handed it: its failed asset just set, not saved yet. */
function savedCase(account: string): Row {
    const kase = recordOf<ForeignRecord>(CASES, { sys_id: 'case1', account, x_daas_ham_failed_asset: 'asset1' })
    takeFailedAssetTerms(kase)
    return { account: kase.getValue('account') ?? '', tier: kase.getValue('x_daas_ham_replacement_tier') ?? '' }
}

beforeEach(() => {
    platform.reset()
    platform.references = { [`${ASSETS}.x_daas_ham_agreement`]: 'x_daas_ham_agreement' }
    platform.tables.x_daas_ham_agreement = [{ sys_id: 'agr1', replacement_tier: 'nbd' }]
    platform.tables[ASSETS] = [failedUnit('acme')]
    platform.tables[CASES] = [{ sys_id: 'case1', number: 'CS0001', account: 'acme', x_daas_ham_failed_asset: 'asset1' }]
})

describe('a case naming a failed asset', () => {
    it("takes the Asset's Customer and its Agreement's service level when it names no account", () => {
        expect(savedCase('')).toEqual({ account: 'acme', tier: 'nbd' })
    })

    it("takes the service level when its account is the Asset's Customer", () => {
        expect(savedCase('acme')).toEqual({ account: 'acme', tier: 'nbd' })
    })

    it("takes nothing from another Customer's Asset, and keeps its account", () => {
        expect(savedCase('other')).toEqual({ account: 'other', tier: '' })
    })
})

describe('Raise replacement', () => {
    it("raises no Order for a failed asset that is another Customer's than the case's account", () => {
        platform.tables[ASSETS] = [failedUnit('other')]

        expect(raiseReplacement(storedCase())).toEqual({ outcome: 'not_raised', why: OTHER_CUSTOMERS })

        expect(rows(ORDERS)).toEqual([])
        expect(rows(CASES)[0]?.x_daas_ham_replacement_order ?? '').toBe('')
    })

    it("goes on to raise the Order for the Asset's Customer, at its Site, when that is the case's account", () => {
        const tried: Row[] = []
        platform.refuses = (table, row, operation) => {
            if (table !== ORDERS || operation !== 'insert') return ''
            tried.push({ customer: row.customer ?? '', site: row.site ?? '' })
            return 'refused for this test'
        }

        expect(raiseReplacement(storedCase())).toEqual({ outcome: 'not_raised', why: 'Replacement order not raised: refused for this test' })

        expect(tried).toEqual([{ customer: 'acme', site: 'site1' }])
    })
})
```

The last test stops the Order at its insert with `platform.refuses`. It proves that a matching case
passes the new check and that the Order names the asset's Customer and Site, without the setup the
whole submission would need.

**Verify**: `npx vitest run src/server/platform/breakfix.test.ts` → 3 pass, 2 fail. The failures are:

- `takes nothing from another Customer's Asset, and keeps its account` fails with `expected { account: 'other', tier: 'nbd' } to deeply equal { account: 'other', tier: '' }`.
- `raises no Order for a failed asset that is another Customer's than the case's account` fails with `fake Glide: x_daas_ham_order.site is dot-walked but not declared in platform.references`. That error means today's code inserted the Order and began to submit it, which is the bug.

### Step 2: Add the pure rule and its tests

In `src/server/domain/breakfix.ts`, replace lines 21-29 (the `replacementProblem` doc comment and
function, shown in "Current state") with:

```ts
/**
 * Whether the failed Asset a case names is another Customer's than the case's account. A case with no account yet
 * takes the Asset's Customer (platform/breakfix `takeFailedAssetTerms`), so it is never another's.
 */
export function isAnotherCustomers(caseAccountId: string, assetCustomerId: string): boolean {
    return caseAccountId !== '' && caseAccountId !== assetCustomerId
}

/**
 * Why "Raise replacement" raises no Order for the case's failed Asset, or null when it does: only a fleet asset (ADR
 * 0016) installed at a Site is replaced like-for-like, and only for the Customer the case is about: the Order is
 * raised for the Asset's Customer, at its Site.
 */
export function replacementProblem(failed: { fleet: boolean; stage: Stage | null; customerId: string }, caseAccountId: string): string | null {
    if (!failed.fleet) return 'Only a fleet asset is replaced: the failed asset is not one'
    if (isAnotherCustomers(caseAccountId, failed.customerId)) return "The failed asset is not the case account's: set the account or the failed asset right first"
    if (failed.stage === null || !INSTALLED_STAGES.includes(failed.stage)) return 'Only installed assets can be replaced'
    return null
}
```

In `src/server/domain/breakfix.test.ts`:

1. Change the import on line 2 to `import { isAnotherCustomers, replacementProblem, replacementStep } from './breakfix'`.
2. In the three existing `replacementProblem` tests (lines 26-40), give every call the new arguments. `replacementProblem({ fleet: false, stage: 'in_service' })` becomes `replacementProblem({ fleet: false, stage: 'in_service', customerId: 'acme' }, 'acme')`. Each `replacementProblem({ fleet: true, stage })` becomes `replacementProblem({ fleet: true, stage, customerId: 'acme' }, 'acme')`. The expected values stay as they are.
3. Inside `describe('replacementProblem', ...)`, after its last test, add:

    ```ts
        it("replaces no asset of another Customer than the case's account", () => {
            const problem = "The failed asset is not the case account's: set the account or the failed asset right first"
            expect(replacementProblem({ fleet: true, stage: 'in_service', customerId: 'other' }, 'acme')).toBe(problem)
            expect(replacementProblem({ fleet: true, stage: 'in_service', customerId: '' }, 'acme')).toBe(problem)
        })

        it("replaces the asset of a case with no account: the Order is the Asset's Customer's", () => {
            expect(replacementProblem({ fleet: true, stage: 'in_service', customerId: 'acme' }, '')).toBeNull()
        })
    ```

4. At the end of the file, add:

    ```ts
    describe('isAnotherCustomers', () => {
        it("is true only when the case names an account that is not the Asset's Customer", () => {
            expect(isAnotherCustomers('acme', 'other')).toBe(true)
            expect(isAnotherCustomers('acme', '')).toBe(true)
            expect(isAnotherCustomers('acme', 'acme')).toBe(false)
            expect(isAnotherCustomers('', 'other')).toBe(false)
        })
    })
    ```

Do not run `npm run typecheck` yet. `platform/breakfix.ts` still calls the old signature until step 3.

**Verify**: `npx vitest run src/server/domain/breakfix.test.ts` → 10 tests pass.

### Step 3: Use the rule in the case rule and the button

In `src/server/platform/breakfix.ts`:

1. Line 2 becomes `import { isAnotherCustomers, replacementProblem, replacementStep } from '../domain/breakfix.ts'`.
2. Replace the doc comment and body of `takeFailedAssetTerms` (lines 28-38) with:

    ```ts
    /**
     * Before insert/update rule on cases naming a failed Asset (br_case_failed_asset), wired here: the case takes its
     * service level from the Asset and, when it names no account yet, its Customer. A failed asset outside the fleet
     * (ADR 0016), or another Customer's than the case's account, set past the field's reference qualifier, gives the
     * case nothing, and Raise replacement refuses it (`raiseReplacement`): the rule sits on a table of another scope,
     * where it cannot refuse the save. `current` is the rule's case, which the platform saves.
     */
    export function takeFailedAssetTerms(current: ForeignRecord): void {
        const asset = findById('alm_hardware', str(current, 'x_daas_ham_failed_asset'))
        if (!asset || !isFleetAsset(asset)) return
        if (isAnotherCustomers(str(current, 'account'), str(asset, 'company'))) return
        current.setValue('x_daas_ham_replacement_tier', str(asset, 'x_daas_ham_agreement.replacement_tier'))
        if (!str(current, 'account')) current.setValue('account', str(asset, 'company'))
    }
    ```

3. In `raiseReplacement`, replace line 63 with:

    ```ts
        const problem = replacementProblem({ fleet: isFleetAsset(failed), stage: readStage(failed), customerId: str(failed, 'company') }, str(kase, 'account'))
    ```

Change nothing else in the file. The `createOrder` call keeps reading the Customer and Site from
the asset.

**Verify**:

- `npx vitest run src/server/platform/breakfix.test.ts src/server/domain/breakfix.test.ts` → 15 tests pass.
- `npm run typecheck` → exit 0.

### Step 4: Update the spec

In `docs/spec/p2-aftersales.md`, replace the bullet at lines 8-11 (shown in "Current state") with
this text. Keep the file's line width of about 100 characters.

```md
- A CSM case names the **failed asset**, a fleet asset (the field offers fleet assets only). The case
  takes the Agreement's replacement service level and, when it names no account yet, the Asset's
  Customer as its account. A failed asset outside the fleet, set past the field's qualifier by a
  script, gives the case neither, and **Raise replacement** refuses it (*Only a fleet asset is
  replaced*). A failed asset of another Customer than the case's account gives the case nothing
  either and leaves its account as it is, and **Raise replacement** refuses it (*The failed asset is
  not the case account's*): the Order is raised for the Asset's Customer, at its Site
  (`domain/breakfix.ts` `isAnotherCustomers`).
```

**Verify**: `grep -n "isAnotherCustomers" docs/spec/p2-aftersales.md` → one match.

### Step 5: Run the gate and commit

Run `npm run check`.

**Verify**: exit 0. The test summary shows no failed test. The count is the count before this plan
plus 8 (1594 when this plan runs directly on `1864b17` with plan 001).

Then run `git status --short`. Expect exactly the five in-scope files. This plan adds no server
module, so `src/fluent/generated/keys.ts` should be unchanged. If the build did change it, see
"STOP conditions".

Commit the five files with the subject from "Git workflow".

## Test plan

- `src/server/platform/breakfix.test.ts` (new, 5 tests), modelled on `src/server/platform/orders.test.ts`:
  - the rule gives a case with no account the asset's Customer and service level;
  - the rule gives a case of the same Customer the service level;
  - the rule gives a case of another Customer nothing and keeps its account (the regression);
  - the button raises no Order for another Customer's asset and leaves the case unlinked (the regression);
  - the button goes on to the Order insert, for the asset's Customer and Site, when the account matches.
- `src/server/domain/breakfix.test.ts` (7 tests become 10): the three existing `replacementProblem` tests with the new arguments, two new `replacementProblem` cases, and `isAnotherCustomers`.
- All of these run locally on the fake. No ATF test changes.
- Verification: `npx vitest run src/server/platform/breakfix.test.ts src/server/domain/breakfix.test.ts` → 15 pass.

## Done criteria

All of these are local. None needs an instance.

- [ ] `npm run check` exits 0
- [ ] `npx vitest run src/server/platform/breakfix.test.ts src/server/domain/breakfix.test.ts` → 15 tests pass
- [ ] `grep -n "isAnotherCustomers" src/server/platform/breakfix.ts` shows the import, one use in `takeFailedAssetTerms`, and no other use
- [ ] `grep -n "customerId: str(failed, 'company') }, str(kase, 'account')" src/server/platform/breakfix.ts` → one match
- [ ] `git status --short` lists only the five in-scope files, all committed
- [ ] `plans/README.md` status row updated

Optional check on an instance, not needed to hand the work back. Open a case whose account is
Customer A. Set its *Failed asset* to an installed fleet asset of Customer B with a list edit or a
background script. Click **Raise replacement**. The form shows *The failed asset is not the case
account's: set the account or the failed asset right first*, and no Order exists for the case.

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts.
- Step 1's test run does not give exactly the two failures described. If all five pass, someone has already fixed the bug. If others fail, the fake or the service has changed.
- A step's verification fails twice after a reasonable fix attempt.
- The fix seems to need `setAbortAction`, a new business rule, an ACL, or any file under `src/fluent`. The rule sits on a table of another scope and must only set fields.
- `src/server/built-metadata.test.ts` fails. It holds `takeFailedAssetTerms` to the `ForeignRecord` parameter type and to its wiring. Do not change that test.
- `npm run build` changes `src/fluent/generated/keys.ts`. This plan adds no Fluent record and no server module, so a change there means something outside the plan moved.
- You find evidence that a case's `account` and an asset's `company` can hold different sys_ids for the same Customer (for example an account hierarchy where a case sits on a parent account). The comparison in `isAnotherCustomers` assumes they are equal for one Customer.

## Maintenance notes

- The check compares two sys_ids for equality. If the Provider starts using CSM account hierarchies, or opens cases on a partner account for a child company's equipment, `isAnotherCustomers` is the one place to teach that relation.
- The rule returns early on a mismatch and does not clear a service level the case took from an earlier failed asset. That matches what it does for an asset outside the fleet. If a stale service level starts a replacement SLA on such a case, clear the field in `takeFailedAssetTerms` for both early returns together.
- A reviewer should check that `createOrder` still takes `customerId` and `siteId` from the asset. The fix refuses a mismatch. It does not move the Order to the case's account.
- Deferred: a write ACL on `sn_customerservice_case.x_daas_ham_failed_asset`, and an ATF test that sets the field past the qualifier. The CSM field ACLs on an instance are unknown, and the server check holds without them.
- Plan 012 (`plans/012-customer-routes-cross-tenant-atf.md`) covers the customer page's fault route, which opens cases through `openFaultCase`. Those cases always carry the asset's own Customer, so this plan and 012 do not overlap in code.
