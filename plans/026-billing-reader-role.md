# Plan 026: Give the billing pull API a role of its own, apart from the NMS's

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- src/server/domain/roles.ts src/server/domain/roles.test.ts src/server/domain/billing.ts src/server/domain/device-events.ts src/server/entry/billing.ts src/server/entry/billing.test.ts src/server/entry/in-service.ts src/server/built-metadata.test.ts src/fluent/shared/roles.now.ts src/fluent/shared/rest-api.now.ts src/fluent/in-service/in-service.now.ts README.md docs/spec/p3-billing.md docs/verify-on-instance.md`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition. Line numbers that moved while the
> quoted text is the same are not a mismatch. Three plans written beside
> this one edit the same files, and their changes are expected: plan 023
> adds tests of the pull API to `src/server/entry/billing.test.ts` (Step 3b
> has a variant for that), plan 024 adds imports and a `describe` to that
> file and changes two import lines of `src/server/entry/billing.ts`, and
> plans 024 and 025 add exports to `src/server/domain/billing.ts`. This plan
> works before or after each of them.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none. It may land before or after `plans/023-billing-pull-reset-export-tests.md`,
  which tests the same two routes: Step 3b says what to do in each case.
- **Category**: security
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

The app has one machine role, `x_daas_ham.integration`, and two machine callers use it. The
Provider's NMS posts device events with it. The billing consumer (an ERP) pulls Billing periods and
their lines with it. So each credential can do the other's work:

- a leaked NMS credential reads every Customer's Billing lines and totals;
- the billing consumer's credential posts sightings, and a sighting puts a pending Asset in
  service, which starts its billing. It also passes the create ACL on device events.

After this plan the billing pull API admits `x_daas_ham.finance` or a new role,
`x_daas_ham.billing_reader`, and no longer admits `x_daas_ham.integration`. The new role grants
nothing else: no table ACL names it and the device-events route refuses it. The integration role
keeps the device events and loses the billing pull.

This changes behaviour on an upgraded instance: the billing consumer's user gets HTTP 403 until an
administrator gives it the new role. The plan documents that in README "Upgrading".

## Current state

Files and their roles:

- `src/server/domain/roles.ts`: `ROLE`, the one list of the app's role names, and the role groups.
- `src/fluent/shared/roles.now.ts`: one Fluent `Role(...)` per name in `ROLE`.
- `src/server/domain/device-events.ts`: `DEVICE_EVENT_SENDERS`, who posts device events.
- `src/server/domain/billing.ts`: billing rules, and `PULL_PAGE`, the pull API's page sizes.
- `src/server/entry/billing.ts`: the two pull handlers and their role guard, `canPull`.
- `src/server/entry/in-service.ts`: the device-events handler. Not modified.
- `src/fluent/in-service/in-service.now.ts`: the create ACL on device events. Not modified.
- `src/fluent/shared/rest-api.now.ts`: the routes. One description changes.
- `src/server/built-metadata.test.ts`: reads the built app in `dist/app` and holds it to the lists.

The role names:

```ts
// src/server/domain/roles.ts:6-19
export const ROLE = {
    admin: 'x_daas_ham.admin',
    assetManager: 'x_daas_ham.asset_manager',
    inventoryTech: 'x_daas_ham.inventory_tech',
    fieldTech: 'x_daas_ham.field_tech',
    noc: 'x_daas_ham.noc',
    accountManager: 'x_daas_ham.account_manager',
    finance: 'x_daas_ham.finance',
    customerAdmin: 'x_daas_ham.customer_admin',
    siteContact: 'x_daas_ham.site_contact',
    integration: 'x_daas_ham.integration',
} as const

export type AppRole = (typeof ROLE)[keyof typeof ROLE]
```

The Fluent role, described as the NMS's:

```ts
// src/fluent/shared/roles.now.ts:66-69
export const integration = Role({
    name: ROLE.integration,
    description: 'Machine role for the provider NMS that posts device events (server-side writes need no table roles).',
})
```

Who posts device events, and the two places that list is used:

```ts
// src/server/domain/device-events.ts:4-5
/** Who posts Seen signals to the device-events route, and so creates device events: the Provider NMS, and asset managers. */
export const DEVICE_EVENT_SENDERS = [ROLE.integration, ROLE.assetManager]
```

```ts
// src/server/entry/in-service.ts:10-11
export function postDeviceEvents(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!requireRole(response, DEVICE_EVENT_SENDERS, 'Requires the x_daas_ham.integration role')) return
```

```ts
// src/fluent/in-service/in-service.now.ts:100-106
Acl({
    $id: Now.ID['acl_device_event_create'],
    type: 'record',
    table: 'x_daas_ham_device_event',
    operation: 'create',
    roles: DEVICE_EVENT_SENDERS,
})
```

The billing pull guard, which admits the same role:

```ts
// src/server/entry/billing.ts:88-104
function canPull(response: RESTAPIResponse): boolean {
    return requireRole(response, [ROLE.finance, ROLE.integration], 'Requires the finance or integration role')
}

export function listBillingPeriods(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!canPull(response)) return
    reply(response, 200, recentPeriods(pullPageSize(queryInt(request, 'limit', PULL_PAGE.periods.size), PULL_PAGE.periods)))
}

export function getBillingLines(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!canPull(response)) return
    const offset = queryInt(request, 'offset', 0)
    const limit = pullPageSize(queryInt(request, 'limit', PULL_PAGE.lines.size), PULL_PAGE.lines)
    const page = linesPage(pathParam(request, 'id'), offset, limit)
    if (!page) return reply(response, 404, { error: 'Unknown billing period' })
    reply(response, 200, page)
}
```

`requireRole` (`src/server/platform/rest-api.ts:14-18`) answers HTTP 403 with the error text when
the caller holds none of the roles. It asks `gs.hasRole`, which on an instance is also true for a
role that contains the one asked for, and for a platform administrator.

Where the new list goes, beside the page sizes:

```ts
// src/server/domain/billing.ts:1-5
import { addDays, addMonths } from './calendar.ts'
import { activeDays, currencyKey, divideRounded, fromCents, isMonth, previousMonth, toCents, type MonthBounds } from './money.ts'
import { FLEET_CONDITION, fleetStagesQuery } from './fleet.ts'
import { DEPLOYED_STAGES } from './lifecycle.ts'
import { BILLING_PERIOD_STATUS, STAGE_FIELDS, SUBSCRIPTION_LINE_STATUS, SUBSCRIPTION_LINE_TYPE } from './vocabulary.ts'
```

```ts
// src/server/domain/billing.ts:302-305
export const PULL_PAGE = {
    periods: { size: 24, most: 120 },
    lines: { size: 1000, most: 5000 },
} as const
```

The route description that names the role:

```ts
// src/fluent/shared/rest-api.now.ts:213-221
        {
            $id: Now.ID['rest_naas_billing_periods'],
            name: 'billing_periods',
            method: 'GET',
            path: '/billing_periods',
            shortDescription: 'Most recent billing periods with their status and totals (finance, integration).',
            authentication: true,
            script: listBillingPeriods,
        },
```

The documentation that names the role for both uses:

```md
<!-- README.md:130-135 -->
Assign roles (`x_daas_ham.asset_manager`, `.inventory_tech`, `.field_tech`, `.noc`, `.account_manager`,
`.finance`, `.admin`; customers: `.customer_admin`, `.site_contact`) and assign inventory techs to
their stockrooms ([ADR 0018](docs/adr/0018-platform-fields-over-custom-ones.md)): an inventory tech
works at the NaaS stockrooms whose *Assignment group* they are a member of. Setting a stockroom's
*Assignment group* takes the platform's `inventory_admin` (which `x_daas_ham.admin` contains); adding
a user to a group takes `user_admin`.
```

```md
<!-- README.md:209-210 -->
**Provider NMS → device events** (`POST /api/x_daas_ham/naas/device_events`, role
`x_daas_ham.integration` or `x_daas_ham.asset_manager`):
```

```md
<!-- README.md:248-250 -->
**Billing pull API** (role `x_daas_ham.finance` or `x_daas_ham.integration`):
`GET /api/x_daas_ham/naas/billing_periods` and
`GET /api/x_daas_ham/naas/billing_periods/{id}/lines?offset=<n>&limit=<n>` (`final` once the period is
```

```md
<!-- README.md:256-260 -->
The NMS and billing integrations sign in as an internal user, one without the `snc_external` role
(the Explicit Roles plugin gives such a user `snc_internal`). Their routes, like the warehouse ones,
require `snc_internal` and the platform's *Scripted REST External Default* ACL. Only the site, rack
and `/customer/...` routes admit customer admins and site contacts (`shared/rest-api.now.ts`).
The tracking webhook needs no sign-in and checks its token itself.
```

```md
<!-- README.md:183-185, the last bullet of "### Upgrading" -->
- Work through the checks marked **After an upgrade** in
  [docs/verify-on-instance.md](docs/verify-on-instance.md): adopting the fleet and clearing the
  earlier version's column defaults, and clean-ups of returns, fees and spare-pool purchases.
```

```md
<!-- docs/spec/p3-billing.md:126 -->
- **Pull API** (finance or integration role):
```

```md
<!-- docs/verify-on-instance.md:393-397 -->
Impersonating *Ada Acme
(demo)*, `x_daas_ham_customer.do` lists the Customer's equipment and `x_daas_ham_racks.do` lists
their Sites and racks. Impersonating *Sam Site (demo)*, both pages show only their Sites. As either
user, `GET /api/x_daas_ham/naas/stockrooms` and `/billing_periods` answer HTTP 403.

### NaaS Asset Workspace
```

What was checked and needs no change:

- `src/server/domain/preflight.ts:18` builds `REQUIRED_ROLES` from `PLATFORM_ROLE`, the roles of
  other applications. The app's own roles ship with the app, so the preflight does not list them.
- No role group (`PROVIDER_STAFF`, `BROAD_STAFF`, `MONEY_READERS` and the rest) names
  `ROLE.integration`, and none takes the new role. It is a machine role, not a staff role.
- `src/server/entry/session.ts:9` answers `GET /me` with `Object.values(ROLE)` filtered by
  `gs.hasRole`. It picks the new name up by itself.
- No ATF test calls the pull handlers or names the integration role
  (`grep -rn "integration\|listBillingPeriods" src/fluent --include='*.now.ts'` shows only
  `roles.now.ts`, `rest-api.now.ts` and a comment). This plan adds no ATF test. It adds an instance
  check to `docs/verify-on-instance.md`.
- `src/server/built-metadata.test.ts` has no test that compares the built roles with `ROLE`. This
  plan adds one. At the planned-at commit the build holds 10 `sys_user_role` records and `ROLE` has
  10 names.

### Conventions that apply (README.md "Development", AGENTS.md)

- Role names have one list, `ROLE` in `src/server/domain/roles.ts`. `src/fluent/shared/roles.now.ts`
  declares each one. Both must learn a new role.
- A relative import in `src/server` names the `.ts` file (`./roles.ts`). Without it the instance
  cannot load the module. A `.now.ts` file imports without the extension.
- A `.now.ts` file holds constants, template literals and imports of constants. No function call,
  loop, spread or array element. The build accepts those and writes `Symbol(...)` into the record,
  which `built-metadata.test.ts` then finds.
- The roles in `roles.now.ts` take no `$id`. Follow the `integration` role there.
- `npm run build` rewrites the tracked `src/fluent/generated/keys.ts`. Commit it with the change.
- `npm test` needs `npm run build` first: `built-metadata.test.ts` fails when a file under
  `src/fluent` or `src/server` (tests aside) is newer than `dist/app`. `npx vitest run <path>` of
  another test file needs no build.
- A test is a `*.test.ts` file beside its module. A test of `entry/` runs on
  `src/server/test-support/fake-glide.ts`, whose `gs.hasRole(role)` is true only when
  `platform.user.roles` lists that exact name. It runs no ACL.
- Use the words of `CONTEXT.md`: Billing period, Billing line, Customer, Provider.

## Design decisions (already made, do not reopen)

- **Name**: `x_daas_ham.billing_reader`, key `billingReader`. The name says what the role grants.
  It reads Billing periods and Billing lines through the pull API and does nothing else.
- **No transition period.** The pull API stops admitting `x_daas_ham.integration` in this change.
  Admitting both for a release would keep the hole open for that release.
- **`x_daas_ham.admin` does not contain the new role.** An app administrator already passes the
  guard through `x_daas_ham.finance`, which the admin role contains.
- **No table ACL names the new role.** The handlers read through `GlideRecord`, which no ACL checks.
- **The list is exported from `domain/billing.ts`**, as `DEVICE_EVENT_SENDERS` is from
  `domain/device-events.ts`, so a test can hold the two lists apart.
- **The device-events route is unchanged.** It keeps `x_daas_ham.integration` and
  `x_daas_ham.asset_manager`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| This plan's unit tests | `npx vitest run src/server/domain/roles.test.ts src/server/entry/billing.test.ts` | all pass (2 and 10 tests at `805d5da`) |
| Build | `npm run build` | exit 0; rewrites `dist/` and `src/fluent/generated/keys.ts` |
| Built-metadata tests | `npx vitest run src/server/built-metadata.test.ts` | all pass (75 tests at `805d5da`); needs a fresh build |
| Full gate | `npm run check` | exit 0 (1804 tests at `805d5da`) |

## Scope

**In scope** (the only files you should modify):

- `src/server/domain/roles.ts`
- `src/server/domain/roles.test.ts`
- `src/server/domain/billing.ts`
- `src/server/entry/billing.ts`
- `src/server/entry/billing.test.ts`
- `src/server/built-metadata.test.ts`
- `src/fluent/shared/roles.now.ts`
- `src/fluent/shared/rest-api.now.ts` (one description)
- `src/fluent/generated/keys.ts` (rewritten by `npm run build`; never by hand)
- `README.md`
- `docs/spec/p3-billing.md`
- `docs/verify-on-instance.md`
- `plans/README.md` (your status row only)

**Out of scope** (do NOT touch, even though they look related):

- `src/server/domain/device-events.ts`, `src/server/entry/in-service.ts`,
  `src/fluent/in-service/in-service.now.ts`. The device-events side is right as it is.
- `src/server/domain/preflight.ts`. It lists platform roles only.
- `src/fluent/billing/access.now.ts`. The table ACLs on Billing periods and lines do not change.
- `src/server/platform/billing.ts`. What the pull API answers does not change.
- `src/server/entry/demo-seed.ts`. The demo data has no integration user.
- Any role group in `roles.ts` or `roles.now.ts`.
- `src/server/test-support/fake-glide.ts`.

## Git workflow

- Branch: `advisor/026-billing-reader-role`, from `main`.
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example
  `Give the billing pull API a role apart from the NMS's`. The body says what was wrong (one role
  served the NMS's device events and the billing pull, so each credential could do the other's
  work) and that an upgraded instance must give the billing consumer's user the new role.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Branch and confirm the baseline

```sh
git checkout main && git checkout -b advisor/026-billing-reader-role
npx vitest run src/server/domain/roles.test.ts src/server/entry/billing.test.ts
grep -rn "billing_reader\|billingReader\|BILLING_PULL_READERS" src README.md docs
grep -c "describe('the billing pull API'" src/server/entry/billing.test.ts
```

**Verify**: 0 tests failed. Write down how many passed in `entry/billing.test.ts`: the steps below
call that number E (10 at `805d5da`; more once plan 023 or 024 has landed). `roles.test.ts` has 2.
The first `grep` prints nothing.

The second `grep` tells you which variant of Step 3b applies:

- `0`: plan 023 has not landed. Use **variant A**.
- `1`: plan 023 has landed, and the file already tests the pull API. Use **variant B**.

### Step 2: Declare the role name and the list of pull readers

In `src/server/domain/roles.ts`, add one line to `ROLE`, directly after the `integration` line:

```ts
    integration: 'x_daas_ham.integration',
    billingReader: 'x_daas_ham.billing_reader',
} as const
```

In `src/server/domain/billing.ts`, add this import as the last line of the file's import block
(after the import of `./vocabulary.ts`, line 5 at `805d5da`):

```ts
import { ROLE, type AppRole } from './roles.ts'
```

and add this directly above `export const PULL_PAGE = {` (line 302):

```ts
/**
 * Who pulls Billing periods and their lines through the pull API: finance, and the billing consumer (an ERP), whose
 * machine role reads them and grants nothing else. Not the NMS's role (domain/device-events `DEVICE_EVENT_SENDERS`):
 * a credential that posts device events reads no Customer's bill, and one that reads bills posts no sighting.
 */
export const BILLING_PULL_READERS: readonly AppRole[] = [ROLE.finance, ROLE.billingReader]

```

**Verify**: `npm run typecheck` → exit 0. `npx vitest run src/server/domain` → 0 failed.

### Step 3: Write the failing tests

**3a.** In `src/server/domain/roles.test.ts`, keep the import on line 2 as it is and add two
imports below it, so the three read:

```ts
import { BROAD_STAFF, CUSTOMER_CONTACTS, PROVIDER_STAFF, RACK_PAGE_USERS, ROLE } from './roles'
import { BILLING_PULL_READERS } from './billing'
import { DEVICE_EVENT_SENDERS } from './device-events'
```

(This test file writes its imports without `.ts`, as it does today. Lint passes on that.)

Append this block to the end of the file:

```ts

describe('the machine roles', () => {
    it('are one for each integration: no role both posts device events and pulls billing', () => {
        expect(BILLING_PULL_READERS).toEqual([ROLE.finance, ROLE.billingReader])
        expect(DEVICE_EVENT_SENDERS).toContain(ROLE.integration)
        expect(DEVICE_EVENT_SENDERS.filter((role) => BILLING_PULL_READERS.includes(role))).toEqual([])
    })
})
```

**3b.** In `src/server/entry/billing.test.ts`. Use the variant Step 1 chose.

**Variant A (plan 023 has not landed).**

1. In the import from `'./billing.ts'` (line 2 at `805d5da`), add the names `getBillingLines` and
   `listBillingPeriods`. At `805d5da` the line then reads:

   ```ts
   import { generateBillingLines, getBillingLines, guardBillingPeriodMonth, listBillingPeriods, uiCloseBillingPeriod, uiRegenerateBillingPeriod } from './billing.ts'
   ```

   If plan 024 has changed that import, keep its names and add these two.

2. Add these two imports after the existing `import { EVENT } from '../domain/events.ts'` line,
   each only if the file does not have it yet:

   ```ts
   import { ROLE } from '../domain/roles.ts'
   import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
   ```

3. Append this block to the end of the file:

   ```ts

   describe('the billing pull API', () => {
       type Handler = (request: RESTAPIRequest, response: RESTAPIResponse) => void
       const REFUSED = { status: 403, body: { error: 'Requires the finance or billing reader role' } }

       /** Call a pull handler as a user holding `roles`, for a period that does not exist. */
       function pull(handler: Handler, roles: string[]): { status: number; body: unknown } {
           platform.user = { ...platform.user, id: 'puller', roles }
           const reply = { status: 0, body: null as unknown }
           const request = { pathParams: { id: 'no-such-period' }, queryParams: {} } as unknown as RESTAPIRequest
           const response = {
               setStatus: (status: number) => void (reply.status = status),
               setBody: (body: unknown) => void (reply.body = body),
           } as unknown as RESTAPIResponse
           handler(request, response)
           return reply
       }

       it('lists the Billing periods for finance and for the billing reader', () => {
           for (const role of [ROLE.finance, ROLE.billingReader]) {
               expect(pull(listBillingPeriods, [role]), role).toEqual({ status: 200, body: { periods: [] } })
           }
       })

       it('reads lines for them too: a period that does not exist is not found, not forbidden', () => {
           for (const role of [ROLE.finance, ROLE.billingReader]) {
               expect(pull(getBillingLines, [role]), role).toEqual({ status: 404, body: { error: 'Unknown billing period' } })
           }
       })

       it("refuses the NMS's integration role, an asset manager and a user with no role", () => {
           for (const roles of [[ROLE.integration], [ROLE.assetManager], []]) {
               expect(pull(listBillingPeriods, roles), roles.join()).toEqual(REFUSED)
               expect(pull(getBillingLines, roles), roles.join()).toEqual(REFUSED)
           }
       })
   })
   ```

**Variant B (plan 023 has landed).** The file then has a helper `pull(route, sent, roles)` at
module level, whose callers default to the integration role, and a
`describe('the billing pull API', ...)` whose last test names the old error text. Add no new
`describe`. Make these three edits instead:

1. In the `pull` helper, change the default caller from the integration role to the billing
   reader. Replace

   ```ts
       roles: string[] = [ROLE.integration],
   ```

   with

   ```ts
       roles: string[] = [ROLE.billingReader],
   ```

2. In `describe('the billing pull API', ...)`, replace the whole test
   `it('answers 404 for a period it does not know, and 403 without the finance or integration role', ...)`
   with:

   ```ts
       it('answers 404 for a period it does not know, and 403 without the finance or billing reader role', () => {
           expect(pull(getBillingLines, { id: 'nosuch' })).toEqual({ status: 404, body: { error: 'Unknown billing period' } })
           const refused = { status: 403, body: { error: 'Requires the finance or billing reader role' } }
           expect(pull(getBillingLines, { id: 'p9' }, [ROLE.assetManager])).toEqual(refused)
           expect(pull(listBillingPeriods, {}, [])).toEqual(refused)
           expect(pull(listBillingPeriods, {}, [ROLE.finance]).status).toBe(200)
       })
   ```

3. Add this test directly after it, inside the same `describe`:

   ```ts

       it("refuses the NMS's integration role on both routes", () => {
           const refused = { status: 403, body: { error: 'Requires the finance or billing reader role' } }
           expect(pull(listBillingPeriods, {}, [ROLE.integration])).toEqual(refused)
           expect(pull(getBillingLines, { id: 'p9' }, [ROLE.integration])).toEqual(refused)
       })
   ```

If the helper or the test is not as quoted here, STOP: plan 023 landed in another form.

**3c.** In `src/server/built-metadata.test.ts`, insert this block directly above the comment that
starts `* domain/events EVENT is the one list of the app's events.` (the `/*` line is line 1107),
with one blank line after it:

```ts
/*
 * domain/roles ROLE is the one list of the app's roles. A role the server code asks for but the metadata does not
 * declare exists on no instance: gs.hasRole is then false for everyone but an administrator, and the build passes.
 */
describe('roles', () => {
    it('are declared, each once, under the name the server code asks for', () => {
        expect(
            records('sys_user_role')
                .map((role) => role.name)
                .sort(),
        ).toEqual(Object.values(ROLE).sort())
    })
})

```

Add no import there: `records` and `ROLE` are already in the file.

**Verify**: `npx vitest run src/server/domain/roles.test.ts src/server/entry/billing.test.ts`

- Variant A → 3 failed, E + 3 passed (`3 failed | 13 passed` at `805d5da`). The three failures are
  exactly the three new tests of `the billing pull API`: the first two fail because the billing
  reader is answered 403, the third because the integration role is answered 200.
- Variant B → 7 failed, E − 3 passed. The seven failures are exactly the seven tests of
  `the billing pull API`: six because their caller, now the billing reader, is answered 403, and
  the new one because the integration role is still let in.

`the machine roles` passes already in both variants: Step 2 declared the list. If the set of
failures differs, STOP.

### Step 4: Admit the pull readers, not the integration role

In `src/server/entry/billing.ts`:

1. In the import from `'../domain/billing.ts'` (line 3 at `805d5da`), add the name
   `BILLING_PULL_READERS`. At `805d5da` the line then reads:

   ```ts
   import { BILLING_PULL_READERS, billingMonthProblem, monthChangedError, PULL_PAGE, pullPageSize } from '../domain/billing.ts'
   ```

   If plan 024 has changed that import, keep its names and add this one.

2. Replace `canPull` (lines 88-90 at `805d5da`) with:

   ```ts
   function canPull(response: RESTAPIResponse): boolean {
       return requireRole(response, BILLING_PULL_READERS, 'Requires the finance or billing reader role')
   }
   ```

Leave the `ROLE` import: `uiResetBillingGeneration` still uses `ROLE.admin`.

**Verify**: `npx vitest run src/server/domain/roles.test.ts src/server/entry/billing.test.ts`
→ 0 failed (variant A: 3 and E + 3 passed, which is 16 at `805d5da`; variant B: 3 and E + 1
passed). `npm run typecheck` → exit 0.
`grep -n "ROLE.integration" src/server/entry/billing.ts` → no output.

### Step 5: Declare the role in the metadata, and build

In `src/fluent/shared/roles.now.ts`, insert directly after the `integration` role (it ends on
line 69) and before the comment `The role groups hold role names`:

```ts

export const billingReader = Role({
    name: ROLE.billingReader,
    description: 'Machine role for the billing consumer (an ERP) that reads Billing periods and their lines through the pull API; it grants no table and posts no device events.',
})
```

In `src/fluent/shared/rest-api.now.ts`, change the description on line 218 to:

```ts
            shortDescription: 'Most recent billing periods with their status and totals (finance, billing reader).',
```

Then run `npm run build`.

**Verify**:

- `npm run build` → exit 0.
- `git diff --numstat -- src/fluent/generated/keys.ts` → a first number above 0 and a second number
  of `0` (lines added, none deleted). `grep -c "x_daas_ham.billing_reader" src/fluent/generated/keys.ts`
  → at least `1`.
- `grep -l "<name>x_daas_ham.billing_reader</name>" dist/app/update/sys_user_role_*.xml | wc -l` → `1`.
- `npx vitest run src/server/built-metadata.test.ts` → 0 failed, and one test more than before
  this plan: `roles > are declared, each once, under the name the server code asks for` (76 passed
  at `805d5da`, the 75 existing tests and this one).

To see that the new built-metadata test guards anything, you may check it once the other way:
before this step it fails with `x_daas_ham.billing_reader` missing from the built names. You do not
need to reproduce that.

### Step 6: Update the documents

The line numbers below are those of `805d5da`. Other plans add lines to these documents, so find
each place by the text quoted in "Current state", not by its number.

**6a. `README.md`**, four places.

1. After the paragraph that ends with the words *a user to a group takes* and the role name
   `user_admin` (line 135), add a new paragraph, with one blank line before and after it:

   ```md
   The two machine roles go to integration users only, one user each: `x_daas_ham.integration` to
   the NMS's user and `x_daas_ham.billing_reader` to the billing consumer's
   ([Integrations](#integrations)). Neither is contained in a staff role.
   ```

2. Replace line 248 with:

   ```md
   **Billing pull API** (role `x_daas_ham.finance` or `x_daas_ham.billing_reader`):
   ```

3. Replace the first sentence of the paragraph at lines 256-257. It starts *The NMS and billing
   integrations sign in as an internal user* and ends with the closing bracket after
   `snc_internal`. The new text is:

   ```md
   The NMS and the billing consumer each sign in as an internal user of their own, one without the
   `snc_external` role (the Explicit Roles plugin gives such a user `snc_internal`). The NMS's user
   holds `x_daas_ham.integration` and the billing consumer's holds `x_daas_ham.billing_reader`: the
   billing pull API refuses the first and the device-events route the second, so neither credential
   does the other's work.
   ```

   Keep the rest of that paragraph as it is.

4. In `### Upgrading`, insert this bullet directly above the last bullet (`- Work through the
   checks marked **After an upgrade** in`):

   ```md
   - Straight after upgrading, give the billing consumer's integration user the role
     `x_daas_ham.billing_reader`, which this version adds, and take `x_daas_ham.integration` from
     it. The billing pull API no longer admits `x_daas_ham.integration`, so until then its pulls are
     answered HTTP 403. Nothing is lost by that: a pull is a read, to send again. Where the NMS and
     the billing consumer shared one user, give the billing consumer a user of its own
     ([machine roles](docs/verify-on-instance.md#machine-roles)).
   ```

**6b. `docs/spec/p3-billing.md`**, line 126. Replace it with:

```md
- **Pull API** (role `x_daas_ham.finance`, or `x_daas_ham.billing_reader`, the machine role of the
  billing consumer; the NMS's `x_daas_ham.integration` is refused with HTTP 403):
```

**6c. `docs/verify-on-instance.md`**. Insert this section after the paragraph that ends
`` `GET /api/x_daas_ham/naas/stockrooms` and `/billing_periods` answer HTTP 403. `` (line 395) and
before `### NaaS Asset Workspace`, with one blank line before and after it:

```md
### Machine roles

`shared/roles.now.ts`, `entry/billing.ts`. Also **after an upgrade**. As an internal user holding
only `x_daas_ham.billing_reader`, `GET /api/x_daas_ham/naas/billing_periods` and
`/billing_periods/<id>/lines` answer HTTP 200, and `POST /api/x_daas_ham/naas/device_events`
answers HTTP 403 *Requires the x_daas_ham.integration role*. As an internal user holding only
`x_daas_ham.integration`, both billing routes answer HTTP 403 *Requires the finance or billing
reader role*, and a device-events batch is taken as before (HTTP 202). After an upgrade, the
billing consumer's user holds `x_daas_ham.billing_reader` and no longer `x_daas_ham.integration`.
```

**Verify**:

- `grep -c "x_daas_ham.billing_reader" README.md` → at least `4`
- `grep -c "role \`x_daas_ham.finance\` or \`x_daas_ham.integration\`" README.md` → `0`
- `grep -c "billing_reader" docs/spec/p3-billing.md` → `1`
- `grep -c "### Machine roles" docs/verify-on-instance.md` → `1`

### Step 7: Run the full gate and commit

```sh
npm run check
git status --short
```

**Verify**: `npm run check` exits 0. Vitest reports 0 failed, and more tests than before this plan:
5 more with variant A (1809 if nothing else landed since `805d5da`), 3 more with variant B.
`git status --short` lists only the in-scope files, `src/fluent/generated/keys.ts` among them.

Commit them in one commit, with the subject from "Git workflow" and a body that says what was wrong
and why.

## Test plan

- `src/server/entry/billing.test.ts`, variant A: new `describe('the billing pull API', ...)`,
  3 tests, modelled on `src/server/entry/session.test.ts` (a handler called with stand-in request
  and response objects, the caller's roles set on `platform.user`):
  - finance and the billing reader list the Billing periods (HTTP 200);
  - finance and the billing reader are let through to a period's lines (HTTP 404 for a period that
    does not exist, which shows the role guard passed);
  - the integration role, an asset manager and a user with no role get HTTP 403 from both handlers.
    This is the regression the plan fixes.
- `src/server/entry/billing.test.ts`, variant B: plan 023's tests of the pull API now call it as
  the billing reader, its 403 test names the new error text, and 1 new test holds that the
  integration role gets HTTP 403 from both handlers.
- `src/server/domain/roles.test.ts`, new `describe('the machine roles', ...)`, 1 test: the pull
  readers are finance and the billing reader, and no role is in both that list and
  `DEVICE_EVENT_SENDERS`.
- `src/server/built-metadata.test.ts`, new `describe('roles', ...)`, 1 test: the built
  `sys_user_role` records are exactly the names in `ROLE`. It fails when a name is added to `ROLE`
  and no `Role(...)` declares it.
- Verification: `npm run build && npx vitest run src/server/domain/roles.test.ts src/server/entry/billing.test.ts src/server/built-metadata.test.ts`
  → 0 failed (3, 13 and 76 tests at `805d5da` with variant A).

What the tests cannot show. The fake Glide's `gs.hasRole` compares names only. That a platform
administrator, or an app administrator through `x_daas_ham.finance`, still passes the guard, and
that the two routes answer as documented over HTTP, needs an instance: the new *Machine roles*
section of `docs/verify-on-instance.md`. Variant A does not call the lines page with real lines:
at `805d5da` the fake Glide has no `chooseWindow`. Plan 023 adds it and tests the pages.

## Done criteria

Local (these suffice to hand the work back). ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm run check` exits 0, with 0 failed tests
- [ ] `grep -rn "ROLE.integration" src/server --include='*.ts' | grep -v "\.test\.ts"` prints exactly one line, in `src/server/domain/device-events.ts` (at `805d5da` it prints two: that one and `entry/billing.ts:89`)
- [ ] `grep -n "billingReader" src/server/domain/roles.ts src/server/domain/billing.ts src/fluent/shared/roles.now.ts` shows the name in all three files
- [ ] `git diff --numstat main..HEAD -- src/fluent/generated/keys.ts` shows lines added and `0` deleted
- [ ] `git status --short` is empty and only in-scope files differ from `main`
- [ ] `plans/README.md` status row updated

Instance only (report as "not verified" if you have no instance; do not block on it):

- [ ] The checks of the new `### Machine roles` section of `docs/verify-on-instance.md` hold after
      an install.

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts.
- `ROLE` already has a second machine role, or `canPull` no longer names `ROLE.integration`.
  Someone has started this change.
- Step 3 gives a different set of failing tests than its variant lists (three for variant A, seven
  for variant B).
- Step 1's second `grep` prints a number other than `0` or `1`, or variant B's helper and test are
  not as Step 3b quotes them.
- A test fails with a message that starts with `fake Glide:`, or with a `TypeError` that names a
  Glide method. Report the message. Do not extend `fake-glide.ts` under this plan.
- `npm run typecheck` fails in `src/client` after Step 2. Some client code may list every
  `AppRole` exhaustively. Report the file and the error. Do not add the machine role to a page's
  audience to make it compile.
- After Step 5, `git diff --numstat -- src/fluent/generated/keys.ts` shows deleted lines, or the
  new `roles` test still fails after a fresh build. Report the built role names
  (`grep -h "<name>" dist/app/update/sys_user_role_*.xml`).
- Any test of `built-metadata.test.ts` other than the new one fails after a fresh build. Report
  which one. Do not edit an existing test to make it pass.
- The operator says the billing consumer must keep working through an upgrade with no step by an
  administrator. That asks for a transition period, which this plan rules out. It is their call:
  the change would be to add `ROLE.integration` back to `BILLING_PULL_READERS` for one release,
  with the tests and the README saying so, but only on their word.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The upgrade step cannot be done ahead of time: the role does not exist on an instance until the
  upgrade installs it. The billing consumer's pulls answer HTTP 403 from the upgrade until an
  administrator assigns the role. Plan the upgrade with whoever runs the billing consumer.
- Plan 023 (`plans/023-billing-pull-reset-export-tests.md`) tests the same two routes and was
  written against the old guard: its helper calls them as the integration role, and one of its
  tests names the old error text. Land 023 first and this plan second (variant B), which is the
  order of their numbers. If this plan lands first, whoever runs 023 must make variant B's three
  edits to 023's own code before its tests can pass.
- A third machine caller takes a role of its own and a list of its own, and the test
  `the machine roles` gains a line that holds it apart from the other two.
- `x_daas_ham.integration` still passes the create ACL on `x_daas_ham_device_event`
  (`in-service.now.ts:100-106`). That is the NMS's own table and stays.
- A reviewer should check four things: `canPull` names the list and not the integration role, no
  table ACL or role group gained the new role, `keys.ts` has additions only, and the README
  "Upgrading" bullet is there.
- Deferred: an ATF test of the pull API. It would call the handlers from a *Run Server Side Script*
  step as an impersonated user, as `customerRoutesOtherCustomerTest` in
  `src/fluent/shared/visibility-tests.now.ts` does for the customer routes. The unit tests cover
  the guard, and the instance check covers the routes over HTTP.
