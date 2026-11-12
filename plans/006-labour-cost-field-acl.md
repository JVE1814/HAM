# Plan 006: Keep a work order's NaaS labour cost to provider staff, and its edits to asset managers and finance

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1864b17..HEAD -- src/fluent/margin/margin.now.ts src/fluent/shared/platform-tables.now.ts src/fluent/shared/roles.now.ts src/server/built-metadata.test.ts src/server/domain/roles.ts docs/spec/p1-models-and-visibility.md docs/adr/0005-visibility-by-before-query-rules.md docs/verify-on-instance.md`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-lint-tracked-sources.md
- **Category**: security
- **Planned at**: commit `1864b17`, 2026-11-12

## Why this matters

The app adds a money column, `x_daas_ham_labour_cost`, to the platform's work order table `wm_order`. No ACL of the app names that column, so it is read and changed with its record by whoever the platform's Field Service ACLs let into a work order. That is every field tech, and the Provider IT's own field staff who hold no NaaS role. The value feeds Margin: `platform/margin.ts` turns it into a *Field labour* Cost fact when a billing period closes. The app's two other Provider-only money fields (a Shipment's carrier cost, an Asset's OEM support cost) each have a field ACL for exactly this reason. This plan adds the same guard here: provider staff read the field, and only asset managers and finance change it by hand.

Who reads `wm_order` on a given instance is not known from the repo (the platform owns those ACLs). The field ACLs make the answer not matter.

## Current state

Files and their roles:

- `src/fluent/shared/platform-tables.now.ts`: the columns the app adds to platform tables. Declares the labour cost column. Not modified by this plan.
- `src/server/platform/margin.ts`: reads the column into Cost facts. Not modified.
- `src/fluent/margin/margin.now.ts`: the margin feature's Fluent metadata (tables, the visit cost property, ACLs, forms). The two new ACLs go here.
- `src/fluent/delivery/access.now.ts` and `src/fluent/fleet/access.now.ts`: the precedents to copy.
- `src/fluent/shared/roles.now.ts`: the `Role` objects and role groups the metadata names.
- `src/server/built-metadata.test.ts`: reads the built app in `dist/app` and holds the ACLs to the rules. The new test goes here.

The column, `src/fluent/shared/platform-tables.now.ts:153-164`:

```ts
export const wm_order = Table({
    augments: 'wm_order',
    // The app record a work order belongs to (an Order, a Return order or an Audit) is the platform's Initiated from
    // (sm_order.initiated_from); its change request names it as its Parent (ADR 0018).
    schema: {
        x_daas_ham_purpose: ChoiceColumn({
            label: 'NaaS purpose',
            choices: FIELD_PURPOSE_CHOICES,
        }),
        x_daas_ham_labour_cost: DecimalColumn({ label: 'NaaS field labour cost (blank = standard visit cost)' }),
    },
})
```

Its one reader, `src/server/platform/margin.ts:233-234` (inside `addFieldLabour`, which queries `new GlideRecord('wm_order')`):

```ts
        const amount = labourCost(str(workOrder, 'x_daas_ham_labour_cost'), visitCost)
        ledger.add({ customerId, siteId: str(workOrder, 'location'), type: 'field_labour', currency: currency.currency, amount })
```

No ACL names the field. `grep -rn "labour_cost" src/fluent --include='*.now.ts'` returns only `platform-tables.now.ts:162`. The app has no ACL of any kind on `wm_order`.

The read precedent, `src/fluent/delivery/access.now.ts:53-65`:

```ts
/*
 * The Provider's carrier cost of a label is not the Customer's to read: the customer read ACL above grants the whole
 * Shipment, and a field with no ACL of its own is read with its record. Provider staff, who read every Shipment, keep it.
 */
Acl({
    $id: Now.ID['acl_shipment_cost_read'],
    type: 'record',
    table: 'x_daas_ham_shipment',
    field: 'cost',
    operation: 'read',
    roles: providerStaff,
    description: "NaaS: a Shipment's carrier cost is the Provider's, read by provider staff only (not Customer contacts).",
})
```

The same on a platform table, `src/fluent/fleet/access.now.ts:134-142`:

```ts
Acl({
    $id: Now.ID['acl_alm_hardware_support_cost_read'],
    type: 'record',
    table: 'alm_hardware',
    field: 'x_daas_ham_support_cost',
    operation: 'read',
    roles: providerStaff,
    description: "NaaS: the Provider's OEM support cost is read by provider staff only.",
})
```

The write precedent on an app column of a platform table, `src/fluent/fleet/access.now.ts:164-172`:

```ts
Acl({
    $id: Now.ID['acl_alm_hardware_agreement_write'],
    type: 'record',
    table: 'alm_hardware',
    field: 'x_daas_ham_agreement',
    operation: 'write',
    roles: [assetManager],
    description: "NaaS: an asset's Agreement is changed by hand only by an asset manager.",
})
```

Who corrects money by hand elsewhere in the app, `src/fluent/shared/roles.now.ts:111-118`:

```ts
/** Who writes Lease schedules and their decisions. */
export const leaseEditors = [ROLE.assetManager, ROLE.finance]

/** Who raises or corrects a Fee event by hand, besides the charges the returns workflow raises. */
export const feeEditors = [ROLE.assetManager, ROLE.finance]

/** Who opens or closes a Service interval by hand, when a stage change could not. */
export const intervalEditors = [ROLE.assetManager, ROLE.finance]
```

`src/fluent/shared/roles.now.ts` also exports the `Role` objects `assetManager`, `finance`, `admin` and the group `providerStaff` (line 77, `export const providerStaff = PROVIDER_STAFF`). The app administrator role contains both `assetManager` and `finance` (line 50), so an administrator passes both new ACLs.

Where the new ACLs go, `src/fluent/margin/margin.now.ts`. Its role imports today (lines 17-22):

```ts
import { MONEY_READERS } from '../../server/domain/roles'
import { BILLING_PERIOD_STATUS, COST_TYPE_CHOICES } from '../../server/domain/vocabulary'
import { EVENT } from '../../server/domain/events'
import { computeMargin, uiRecomputeMargin } from '../../server/entry/margin'
import { PROPERTY } from '../../server/domain/properties'
import { admin, finance } from '../shared/roles.now'
```

Its last ACL (lines 175-181), followed by the first `Form(` at line 183:

```ts
Acl({
    $id: Now.ID['acl_margin_delete'],
    type: 'record',
    table: 'x_daas_ham_margin',
    operation: 'delete',
    roles: [admin],
})
```

The existing test of the field read ACLs, `src/server/built-metadata.test.ts:909-928`. It sits inside `describe('the rules and ACLs that scope what a reader sees', ...)` (lines 749-1031):

```ts
    describe("ACLs on the Provider's own fields of records a Customer contact reads", () => {
        const fieldReaders = (table: string, field: string) =>
            builtAcls().filter((acl) => acl.table === table && acl.field === field && acl.operation === 'read' && !acl.deny)

        it('grant them to provider staff, which holds no customer role, so the record a contact reads comes without them', () => {
            const fields: Array<[string, string]> = [
                ['alm_hardware', 'x_daas_ham_support_cost'],
                ['alm_hardware', 'x_daas_ham_claim_code'],
                ['alm_hardware', 'x_daas_ham_lease'],
                ['x_daas_ham_shipment', 'cost'],
            ]
            for (const [table, field] of fields) {
                expect(
                    fieldReaders(table, field).map((acl) => [...acl.roles].sort()),
                    `${table}.${field}`,
                ).toEqual([PROVIDER_STAFF])
            }
            expect(PROVIDER_STAFF.filter(isCustomerRole)).toEqual([])
        })
    })
```

Helpers that test file already defines at module level, and that the new test uses:

- `builtAcls()` (line 704): every built record ACL as `{ table, field, records, operation, deny, roles, appliesTo, condition, script }`. A field ACL is built under the name `<table>.<field>`, which `builtAcls` splits into `table` and `field`.
- `recordAcls()` (line 724): `builtAcls()` without the field ACLs.
- `PROVIDER_STAFF` (line 732): the provider-staff role names, sorted.
- `ROLE` (imported from `./domain/roles`): `ROLE.assetManager` is `'x_daas_ham.asset_manager'`, `ROLE.finance` is `'x_daas_ham.finance'`.

Conventions that apply (from `README.md` "Development", enforced by the build and tests):

- A new Fluent record goes to the feature whose table or server module it serves, whatever table it is declared on. The labour cost serves Margin, so the ACLs go in `src/fluent/margin/margin.now.ts`.
- `.now.ts` files are evaluated statically. They hold constants, template literals over constants, and imports of constants. No function call, loop, spread or array element. A value the SDK cannot read is not a build error; `built-metadata.test.ts` finds it in the built output.
- A new Fluent record takes its sys_id from `$id: Now.ID['<name>']`. `npm run build` adds the new names to the tracked `src/fluent/generated/keys.ts`. Commit that file.
- `built-metadata.test.ts` fails as a whole when any file under `src/fluent` or `src/server` (tests aside) is newer than `dist/app`. Run `npm run build` after editing a `.now.ts` file and before running that test.
- The app's own server logic saves through `GlideRecord`, which no ACL checks (ADR 0005). So the Margin job keeps reading the field after this change. The ACLs bind only what people do on a form, a list or the Table API.

Documentation that describes the Provider-only fields today, each to gain one sentence in step 3:

- `docs/spec/p1-models-and-visibility.md:56-59`:
  ```
  On hardware, the app's own Provider columns (support cost, claim code and lease) are read by provider staff alone,
  whoever reads the Asset, and a Customer contact does not read a fleet asset's *Cost*, which Customer Service's
  ACLs grant its contacts, nor a Shipment's carrier cost (`fleet/access.now.ts`,
  `delivery/access.now.ts`).
  ```
- `docs/adr/0005-visibility-by-before-query-rules.md:106-107`:
  ```
  A Customer contact does not read a fleet asset's cost, which Customer Service's ACLs grant its contacts, nor a
  Shipment's carrier cost. Each Deny-Unless field ACL sits beside an Allow-If ACL of its own name (the platform's, or,
  ```
- `docs/verify-on-instance.md:347-357`, the section `### Changes to hardware by hand`, which ends:
  ```
  deletes one. A consumable's cost is still writable as before. Impersonating a Customer contact who
  also holds `sn_customerservice.customer`, `GET /api/now/table/alm_hardware/<their fleet asset>`
  returns no cost, support cost, claim code or lease, and a Shipment returns no cost.
  ```
  The next section, `### Customer creates`, starts at line 359.

## Design decisions (already made, do not reopen)

- **Read**: `providerStaff`. This is the rule of the two existing cost fields.
- **Write**: asset managers and finance, written inline as `[assetManager, finance]`. These are the roles that correct money by hand everywhere else in the app (`leaseEditors`, `feeEditors`, `intervalEditors`). A field tech keeps saving the work order; only this one field becomes read-only to them. A blank field already means the standard visit cost, so a tech has nothing to enter for a normal visit.
- **No new role group** in `shared/roles.now.ts`. An inline list of `Role` objects is an existing pattern (`roles: [assetManager]` in `fleet/access.now.ts`, `roles: [assetManager, fieldTech, customerAdmin, siteContact]` in `delivery/logic.now.ts:40`).
- **No field `create` ACL.** The app's other guarded money and ownership fields have a `write` ACL only (`acl_alm_hardware_agreement_write`, `acl_alm_hardware_lease_write`). Match them.
- **No record ACL on `wm_order`.** The platform owns who reads and saves a work order. An Allow-If record ACL of the app's there would widen access.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 (needs plan 001; before it, use `npx eslint src`) |
| Build | `npm run build` | exit 0; rewrites `dist/` and `src/fluent/generated/keys.ts` |
| One test file | `npx vitest run src/server/built-metadata.test.ts` | all pass (72 tests at `1864b17`) |
| Full gate | `npm run check` | typecheck, lint, build and vitest all pass (1586 tests at `1864b17`) |

## Scope

**In scope** (the only files you should modify):

- `src/fluent/margin/margin.now.ts`
- `src/server/built-metadata.test.ts`
- `src/fluent/generated/keys.ts` (rewritten by `npm run build`; do not edit by hand)
- `docs/spec/p1-models-and-visibility.md`
- `docs/adr/0005-visibility-by-before-query-rules.md`
- `docs/verify-on-instance.md`

**Out of scope** (do NOT touch, even though they look related):

- `src/fluent/shared/platform-tables.now.ts`: the column itself does not change. Do not add `readOnly` to it; that would also stop asset managers and finance.
- `src/fluent/shared/roles.now.ts` and `src/server/domain/roles.ts`: no new role group.
- `src/server/platform/margin.ts` and `src/server/domain/margin.ts`: Margin's reading of the field does not change.
- `src/fluent/delivery/access.now.ts`, `src/fluent/fleet/access.now.ts`: precedents only.
- Any record ACL, business rule or form on `wm_order`.
- The existing `describe("ACLs on the Provider's own fields of records a Customer contact reads", ...)` block. Whether a Customer contact reads work orders is not known, so the new field gets its own block.

## Git workflow

- Branch: `advisor/006-labour-cost-field-acl`
- One commit for the whole plan. Subject in the repo's style (imperative sentence under 72 characters), for example: `Keep a work order's NaaS labour cost to provider staff`. The body says what was wrong (the field had no ACL of its own, so it was read and changed with the work order) and why it matters (it feeds Margin's Cost facts).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing test

In `src/server/built-metadata.test.ts`, insert a new `describe` block directly after the closing `})` of `describe("ACLs on the Provider's own fields of records a Customer contact reads", ...)` (line 928) and before `describe('create ACLs of Orders, Order lines and Returns', ...)` (line 930). Keep the 4-space nesting of its neighbours:

```ts
    describe("ACLs on a work order's NaaS labour cost", () => {
        const onField = (operation: string) =>
            builtAcls().filter((acl) => acl.table === 'wm_order' && acl.field === 'x_daas_ham_labour_cost' && acl.operation === operation)

        it('keep it to provider staff to read, and to asset managers and finance to change, whoever the platform lets into the work order', () => {
            expect(onField('read').map((acl) => [[...acl.roles].sort(), acl.deny])).toEqual([[PROVIDER_STAFF, false]])
            expect(onField('write').map((acl) => [[...acl.roles].sort(), acl.deny])).toEqual([[[ROLE.assetManager, ROLE.finance].sort(), false]])
        })

        it('leave the work order itself to the platform: the app has no record ACL on wm_order', () => {
            expect(recordAcls().filter((acl) => acl.table === 'wm_order')).toEqual([])
        })
    })
```

Add no imports: `builtAcls`, `recordAcls`, `PROVIDER_STAFF` and `ROLE` are already in the file.

**Verify**: `npx vitest run src/server/built-metadata.test.ts` → exactly 1 test fails, `keep it to provider staff to read, ...`, with a received value of `[]`. 73 tests pass (the 72 existing ones and `leave the work order itself to the platform`). If the whole file fails with a message about sources newer than `dist/app`, run `npm run build` and repeat.

### Step 2: Add the two field ACLs

In `src/fluent/margin/margin.now.ts`:

1. Change the role import on line 22 to:

   ```ts
   import { admin, assetManager, finance, providerStaff } from '../shared/roles.now'
   ```

2. Insert after the `acl_margin_delete` ACL (ends at line 181) and before the first `Form(` (line 183):

   ```ts
   /*
    * A work order's NaaS labour cost is the Provider's figure and feeds the Cost facts above. wm_order is the platform's
    * table, whose own ACLs decide who reads and saves a work order, and a field with no ACL of its own is read and
    * changed with its record: by every field tech, and by the Provider IT's field staff. The Margin pass reads it through
    * GlideRecord, which no ACL checks.
    */
   Acl({
       $id: Now.ID['acl_wm_order_labour_cost_read'],
       type: 'record',
       table: 'wm_order',
       field: 'x_daas_ham_labour_cost',
       operation: 'read',
       roles: providerStaff,
       description: "NaaS: a work order's field labour cost is the Provider's, read by provider staff only.",
   })

   Acl({
       $id: Now.ID['acl_wm_order_labour_cost_write'],
       type: 'record',
       table: 'wm_order',
       field: 'x_daas_ham_labour_cost',
       operation: 'write',
       roles: [assetManager, finance],
       description: "NaaS: a work order's field labour cost is changed by hand only by an asset manager or finance.",
   })
   ```

3. Run `npm run build`.

**Verify**:

- `npm run build` → exit 0.
- `git diff --stat -- src/fluent/generated/keys.ts` → the file changed. `git diff -- src/fluent/generated/keys.ts | grep '^[-+]' | grep -v '^+++\|^---'` → only added lines (`+`), naming `acl_wm_order_labour_cost_read` and `acl_wm_order_labour_cost_write` with table `sys_security_acl`. No removed lines.
- `npx vitest run src/server/built-metadata.test.ts` → all 74 tests pass.

### Step 3: Update the documents that list the Provider-only fields

1. `docs/spec/p1-models-and-visibility.md`: directly after the paragraph that ends `` `delivery/access.now.ts`). `` (line 59), in the same paragraph, add:

   ```
   A work order's *NaaS field labour cost* is read by provider staff alone, whoever reads the work order, and
   changed by hand by asset managers and finance (`margin/margin.now.ts`).
   ```

2. `docs/adr/0005-visibility-by-before-query-rules.md`: on lines 106-107, after the sentence `A Customer contact does not read a fleet asset's cost, which Customer Service's ACLs grant its contacts, nor a Shipment's carrier cost.` and before `Each Deny-Unless field ACL sits beside`, insert this sentence (re-wrap the paragraph to the file's line width):

   ```
   A work order's NaaS field labour cost, the app's column on the platform's `wm_order`, has Allow-If field ACLs of
   its own too: provider staff read it, and asset managers and finance change it by hand (`margin/margin.now.ts`).
   ```

3. `docs/verify-on-instance.md`: insert a new section after line 357 (the end of `### Changes to hardware by hand`) and before `### Customer creates`:

   ```
   ### Work order labour cost

   `margin/margin.now.ts`. Impersonating a field-tech-only user, a work order with a *NaaS purpose*
   saves as before (state, work notes), and `PATCH /api/now/table/wm_order/<id>` with
   `{"x_daas_ham_labour_cost":"180"}` does not change its *NaaS field labour cost*. An asset manager
   or a finance user changes it the same way. A user with no NaaS role who reads the work order (a
   dispatcher of the Provider IT) gets no `x_daas_ham_labour_cost` from `GET
   /api/now/table/wm_order/<id>?sysparm_fields=number,x_daas_ham_labour_cost`. Closing the month's
   billing period afterwards still writes the *Field labour* Cost fact from the cost entered.
   ```

**Verify**:

- `grep -c "NaaS field labour cost" docs/spec/p1-models-and-visibility.md` → `1`
- `grep -c "wm_order" docs/adr/0005-visibility-by-before-query-rules.md` → at least `1`
- `grep -n "### Work order labour cost" docs/verify-on-instance.md` → one match, between `### Changes to hardware by hand` and `### Customer creates`

### Step 4: Run the full gate and commit

Run `npm run check`.

**Verify**: exit 0. Vitest reports 1588 tests passed (1586 at `1864b17` plus the 2 new ones; more if other plans landed first, but none failed). Then `git status --short` lists only the six in-scope files. Commit them, `src/fluent/generated/keys.ts` included.

## Test plan

- New tests in `src/server/built-metadata.test.ts`, in a new `describe("ACLs on a work order's NaaS labour cost", ...)`:
  - the field's read ACL is one Allow-If ACL granting exactly the provider-staff roles, and its write ACL is one Allow-If ACL granting exactly the asset manager and finance roles (the regression this plan fixes; fails before step 2);
  - the app ships no record ACL on `wm_order` (guards the decision to leave the work order to the platform; passes before and after).
- Structural pattern: the neighbouring `describe("ACLs on the Provider's own fields of records a Customer contact reads", ...)` at `src/server/built-metadata.test.ts:909-928`.
- The fake Glide used by the other tests runs no ACL, so no unit test can show a refused read or write. That is the instance check in step 3's new `verify-on-instance.md` section.
- Verification: `npm run build && npx vitest run src/server/built-metadata.test.ts` → 74 pass.

## Done criteria

Local (these suffice to hand the work back):

- [ ] `npm run check` exits 0
- [ ] `npx vitest run src/server/built-metadata.test.ts` passes, including the 2 new tests
- [ ] `grep -n "acl_wm_order_labour_cost_read\|acl_wm_order_labour_cost_write" src/fluent/margin/margin.now.ts src/fluent/generated/keys.ts` shows both names in both files
- [ ] `grep -rn "x_daas_ham_labour_cost" src/fluent --include='*.now.ts' | grep -v generated` shows `platform-tables.now.ts` once and `margin.now.ts` twice
- [ ] `git status --short` shows no file outside the in-scope list
- [ ] `plans/README.md` status row updated

Instance only (report as "not verified" if you have no instance; do not block on it):

- [ ] The checks of the new `### Work order labour cost` section of `docs/verify-on-instance.md` hold after an install.

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts.
- `grep -rn "wm_order" src/fluent --include='*.now.ts'` shows an `Acl(` on `wm_order` that this plan did not add. Someone has already started guarding the table; the design decisions above may no longer hold.
- After step 2, `npm run build` fails, or the new test still receives `[]`. The built ACL may carry another name than `wm_order.x_daas_ham_labour_cost`; report the name found in `dist/app` instead of changing the test's filter.
- After step 2, any test of `built-metadata.test.ts` other than the new one fails. Report which one. Do not edit an existing test to make it pass.
- The `keys.ts` diff after the build removes or changes existing entries. Only two additions are expected.
- On an instance, a field tech can no longer save a work order at all, or the install log refuses the two ACLs because `wm_order` belongs to another scope. Do not widen the roles or move the ACLs by guesswork.
- The operator says field techs are meant to enter the labour cost themselves. That reverses the write decision above and is theirs to make: the change would be `roles: [assetManager, finance, fieldTech]` in the write ACL and in the test, but only on their word.

## Maintenance notes

- A reviewer should look hardest at the write roles. Asset managers and finance were chosen by analogy with fees, leases and service intervals; the repo documents no workflow in which a field tech enters the cost.
- If the app later puts the field on a form or a workspace list for field techs, they will see it read-only. If it is shown to a role outside provider staff, the cell will be empty.
- A new app column of the Provider's on any platform table needs the same pair of ACLs. `built-metadata.test.ts` does not find a missing one by itself; the lists in its two field-ACL blocks are written by hand.
- Deferred: a field `create` ACL (the app's other guarded fields have none), and finding out which platform roles read `wm_order` on the target instance. Neither changes this plan's result.
