# Plan 032: Check an Order or Return order a Customer contact inserts, whatever inserts it

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- src/server/domain/visibility.ts src/server/domain/returns.ts src/server/domain/entitlement.ts src/server/domain/customer-parties.ts src/server/platform/records.ts src/server/platform/session.ts src/server/platform/returns.ts src/server/platform/returns.test.ts src/server/platform/orders.ts src/server/platform/order-submission.test.ts src/server/platform/rule-api.ts src/server/entry/returns.ts src/server/entry/orders.ts src/server/entry/orders.test.ts src/server/test-support/fake-glide.ts src/fluent/returns/logic.now.ts src/fluent/returns/access.now.ts src/fluent/returns/tests.now.ts src/fluent/orders/logic.now.ts src/fluent/orders/access.now.ts docs/adr/0005-visibility-by-before-query-rules.md docs/verify-on-instance.md docs/spec/p1-ordering.md docs/spec/p2-aftersales.md`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition. Line numbers that moved while the
> quoted text is the same are not a mismatch.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

A customer admin has a create ACL on Orders and on Return orders. Each ACL looks only at the
Customer the record names, and the Return's passes a record that names no Customer at all. The
checks that the Site and the Agreement belong to that Customer run somewhere else: in the record
producers' post-insert scripts and in the customer page's route. A record inserted another way
(the Table API, a form) meets the ACL and none of those checks. So a customer admin can save:

- a Return order that names no Customer, or their Customer with another Customer's Site, with any
  trigger and due date. It lands in the staff's lists, where *Create return label* buys a carrier
  label on the Provider's account;
- an Order with another Customer's Site or Agreement. It stays a draft, because *Submit* runs the
  ownership check, but it sits in the staff's lists.

Whether a Customer contact can really reach such an insert on an instance is not known from the
repo. Step 1 is an instance check that the operator runs. If the inserts are not reachable, this
plan is rejected and nothing changes.

The fix is a before-insert rule on each table. In a Customer contact's session it runs the checks
the producers run and refuses the insert on any finding, whatever inserts the record.

## Current state

Files and their roles:

- `src/fluent/returns/access.now.ts`, `src/fluent/orders/access.now.ts`: the create ACLs.
- `src/server/domain/visibility.ts`: `grantsReturnOfOwnCustomer`, the Return create ACL's rule, and
  `isCustomerContact`.
- `src/server/domain/returns.ts`: `returnRequestFindings`, why a requested Return cannot be raised.
- `src/server/domain/entitlement.ts`: `ownershipFindings`, why an Order cannot go ahead as raised.
- `src/server/domain/customer-parties.ts`: the rule both share (`actorRefusal`, `siteFinding`).
- `src/server/platform/returns.ts`: `raiseReturn`, `requestReturn`, `requestProducedReturn`.
- `src/server/platform/orders.ts`: `submitProducedOrder`, `orderParties`.
- `src/server/platform/session.ts`: `currentSession()`, the user's scope and Customer.
- `src/server/platform/records.ts`: `findById` and the record readers.
- `src/server/platform/rule-api.ts`: `abortWith`, how a before rule on an app table refuses.
- `src/server/entry/returns.ts`, `src/server/entry/orders.ts`: the producers' post-insert scripts.
- `src/fluent/returns/logic.now.ts`, `src/fluent/orders/logic.now.ts`: the business rules.
- `src/fluent/returns/tests.now.ts`: the ATF test `customerReturnRequestTest`.

### The create ACLs

```ts
// src/fluent/returns/access.now.ts:66-79
/*
 * A customer admin creates a Return of their own Customer only. One that names no Customer yet passes: the customer
 * page asks whether a Return may be raised at all (canCreate() of an empty record) before it names
 * the Customer, and a Return with none is no Customer's, which no customer contact reads.
 */
Acl({
    $id: Now.ID['acl_return_order_create_customer'],
    type: 'record',
    table: 'x_daas_ham_return_order',
    operation: 'create',
    roles: [customerAdmin],
    description: 'NaaS customer admins create Returns of their own Customer only.',
    script: createsCustomerReturn,
})
```

```ts
// src/server/domain/visibility.ts:315-317
export function grantsReturnOfOwnCustomer(customerId: string, returnCustomer: string): boolean {
    return !!customerId && (returnCustomer === '' || returnCustomer === customerId)
}
```

```ts
// src/fluent/orders/access.now.ts:48-60
/*
 * A customer admin creates an Order of their own Customer only. Every Order rule check of a customer admin is asked
 * of an Order that names its Customer, so one naming none is refused.
 */
Acl({
    $id: Now.ID['acl_order_create_customer'],
    type: 'record',
    table: 'x_daas_ham_order',
    operation: 'create',
    roles: [customerAdmin],
    description: 'NaaS customer admins create Orders of their own Customer only.',
    script: grantsCustomerRecord,
})
```

Site contacts have no create ACL on either table. Neither table has a rule on insert: the only
rules on them are the before-query visibility rules (`src/fluent/shared/visibility.now.ts:70-78`
and `:120-128`).

### Where the checks run today

The Return producer's post-insert script, and the service it calls:

```ts
// src/server/entry/returns.ts:8-14
export function afterReturnProduced(producer: Record<string, unknown>, current: unknown): void {
    const listed = String(producer.assets ?? '')
        .split(',')
        .map((id) => id.trim())
    const outcome = requestProducedReturn(current as GlideRecord, listed)
    if (!outcome.raised) gs.addErrorMessage(`Return not raised. ${outcome.why}.`)
}
```

```ts
// src/server/platform/returns.ts:289-297
export function requestReturn(request: RequestedEquipment): RequestOutcome {
    const { produced, customerId, siteId } = request
    const site = findById('cmn_location', siteId)
    const [finding] = returnRequestFindings({ customerId, site: requestedSite(siteId, site) }, returnRequester(produced))
    if (finding) return notRaised(finding.about === 'requester' ? 'forbidden' : 'invalid', finding.message)
    if (produced) return raiseRequested(request, site)
    const raised = withLock(LOCK.returnRequest(customerId), () => raiseRequested(request, site))
    return raised.ran ? raised.value : notRaised('busy', 'Another return request of yours is being raised: try again in a moment')
}
```

```ts
// src/server/platform/returns.ts:346-354
function requestedSite(siteId: string, site: GlideRecord | null): RequestedReturn['site'] {
    if (!siteId) return undefined
    return { id: siteId, customerId: site ? str(site, 'company') : null, isSite: !!site && bool(site, SITE_FIELD) }
}

function returnRequester(produced: GlideRecord | undefined): ReturnRequester {
    const { permitted, scope, customerId } = creatorOf(produced ?? new GlideRecord(RETURN))
    return { mayRequest: permitted, scope, customerId }
}
```

The findings themselves:

```ts
// src/server/domain/returns.ts:53-58
export function returnRequestFindings(request: RequestedReturn, requester: ReturnRequester): ReturnRequestFinding[] {
    const refusal = returnRequesterRefusal(request.customerId, requester)
    if (refusal) return [{ about: 'requester', message: refusal }]
    const misplaced = request.customerId ? siteFinding(request.customerId, request.site) : CHOOSE_CUSTOMER
    return misplaced ? [{ about: 'site', message: misplaced }] : []
}
```

```ts
// src/server/domain/customer-parties.ts:41-45
export function actorRefusal(customerId: string, actor: CustomerActor, wording: ActWording): string | null {
    if (!actor.permitted || actor.scope === 'own_sites') return `You may not ${wording.act}`
    if (actor.scope === 'own_customer' && customerId !== actor.customerId) return `You can only ${wording.actForOwn} for your own customer`
    return null
}
```

The Order producer's post-insert script, and the Order's side:

```ts
// src/server/entry/orders.ts:29-37
export function afterOrderProduced(producer: Record<string, unknown>, current: unknown): void {
    const asked = deviceRows(producer.devices)
    const devices: NewLine[] = []
    for (const row of asked.rows) {
        if (row.model) devices.push({ modelId: String(row.model), quantity: Math.max(1, Number(row.quantity) || 1) })
    }
    const order = current as GlideRecord
    const submission = submitProducedOrder(order, devices, asked.unread)
    if (submission.submitted || !submission.queued) return tellSubmission(submission)
```

```ts
// src/server/platform/orders.ts:160-174
function orderParties(order: GlideRecord): OrderParties {
    const named = (field: string, table: string, customerField: string): NamedRecord | undefined => {
        const id = str(order, field)
        if (!id) return undefined
        const record = findById(table, id)
        return { id, customerId: record ? str(record, customerField) : null }
    }
    const site = named('site', 'cmn_location', 'company')
    return {
        customerId: str(order, 'customer'),
        agreement: named('agreement', 'x_daas_ham_agreement', 'customer'),
        site: site && { ...site, isSite: bool(order, `site.${SITE_FIELD}`) },
        siteTemplate: named('site_template', 'x_daas_ham_site_template', 'customer'),
    }
}
```

```ts
// src/server/domain/entitlement.ts:149-158
export function ownershipFindings(order: OrderParties, orderer: Orderer): string[] {
    const refusal = raiserRefusal(order.customerId, orderer)
    if (refusal) return [refusal]
    if (!order.customerId) return [CHOOSE_CUSTOMER]
    const findings = [agreementFinding(order.customerId, order.agreement), siteFinding(order.customerId, order.site)].filter(
        (finding): finding is string => finding !== null,
    )
    if (!siteTemplateOffered(order)) findings.push('The site template is not offered to the customer')
    return findings
}
```

### Who inserts these records in a Customer contact's session

This decides what the rule may refuse. Read it before you change anything.

Return orders:

1. A direct insert (the Table API, a form). This is the gap.
2. The record producer *Return or decommission network equipment*. The platform inserts the record
   with the Customer, Site, trigger and method the form mapped, then runs `afterReturnProduced`.
3. The customer page's route. `requestCustomerReturn` (`src/server/entry/customer.ts:96-110`) calls
   `requestReturn` with `customerId: session.customerId`, which runs the findings and then
   `raiseReturn` (`platform/returns.ts:84-99`), the insert.
4. A swap-back. A customer admin **or a site contact** confirms a self-install on the customer
   page (`entry/customer.ts:64-67`, `confirmInstalled`). That retires the Assets the Order
   replaced: `platform/delivery.ts:247` calls `returnSwappedAssets(order, replaced)`, which calls
   `raiseReturn` with the Order's Customer and Site and the trigger `refresh_swap_back` or
   `defective_return` (`platform/returns.ts:106-118`).

Case 4 matters. `returnRequestFindings` with the real requester refuses a site contact (`You may
not request returns`). A rule that ran it that way would refuse the swap-back of a site contact's
confirmation, and the replaced units would stay in service and billed.

Orders: a direct insert, and the record producer *Request network equipment*. The app's own
`createOrder` (`platform/orders.ts:85`) is called by break-fix (`platform/breakfix.ts:68`, a staff
action) and the refresh job (`platform/refresh.ts:123`), never in a contact's session.

Jobs run as the system user, for whom `gs.hasRole` is true for every role. `resolveVisibility`
(`domain/visibility.ts:14-20`) then gives the scope `everything`.

### How a Customer contact is told apart

```ts
// src/server/domain/visibility.ts:216-219
/** Whether `scope` is a Customer contact's (a customer admin or a site contact), kept to their own Customer. */
function isCustomerContact(scope: VisibilityScope): boolean {
    return scope === 'own_customer' || scope === 'own_sites'
}
```

It is not exported today. `currentSession()` (`platform/session.ts:58-68`) gives `scope` and
`customerId`, both read once per user and transaction. A user who holds a staff role beside a
customer role has a staff scope (`resolveVisibility`: the broadest wins) and is not a contact.

### How a before rule on an app table refuses

```ts
// src/server/platform/rule-api.ts:8-12
export function abortWith(current: GlideRecord, why: string | null): void {
    if (!why) return
    gs.addErrorMessage(why)
    current.setAbortAction(true)
}
```

Both tables are the app's own (they extend `task`), so `setAbortAction` works on them
(`docs/research/external-contracts.md` N36: `setAbortAction` on an unsaved record of
`x_daas_ham_staging_task` and `x_daas_ham_disposal_order`, which both extend `task`, leaves
`isActionAborted()` true). A rule on a table of another scope (`alm_hardware`, `wm_order`) must
refuse with its Abort action instead. That does not apply here.

The precedent for the entry function and the Fluent rule:

```ts
// src/server/entry/billing.ts:84-86
export function guardClosedBillingPeriod(current: GlideRecord, previous: GlideRecord): void {
    abortWith(current, closedPeriodRefusal(current, previous))
}
```

```ts
// src/fluent/billing/logic.now.ts:150-159
BusinessRule({
    $id: Now.ID['br_billing_period_month'],
    name: 'NaaS - check billing period month',
    table: 'x_daas_ham_billing_period',
    when: 'before',
    action: ['insert', 'update'],
    order: 100,
    condition: 'current.period.changes()',
    script: guardBillingPeriodMonth,
})
```

Where the new rules go:

```ts
// src/fluent/returns/logic.now.ts:1-20
import '@servicenow/sdk/global'
import { BusinessRule, EmailNotification, Property, Record, ScheduledScript } from '@servicenow/sdk/core'
import { onReturnEvaluated } from '../../server/entry/returns'
...
BusinessRule({
    $id: Now.ID['br_return_evaluated'],
    name: 'NaaS - route evaluated return',
    table: 'x_daas_ham_return_order_line',
    when: 'after',
    action: ['update'],
    order: 200,
    condition: `current.evaluation.changes() && current.evaluation != '' && current.status == '${RETURN_LINE_STATUS.received}'`,
    script: onReturnEvaluated,
})
```

```ts
// src/fluent/orders/logic.now.ts:3 and 14-23
import { onAllocatedAssetStageChange, onOrderApprovalDecision, sourceOrder, uiCancelOrder, uiRecheckApprovals, uiSubmitOrder } from '../../server/entry/orders'
...
BusinessRule({
    $id: Now.ID['br_order_approval_decision'],
    name: 'NaaS - roll up order approvals',
    table: 'sysapproval_approver',
    when: 'after',
    action: ['update'],
    order: 200,
    condition: "current.state.changes() && current.source_table == 'x_daas_ham_order'",
    script: onOrderApprovalDecision,
})
```

### The test stand-in

`src/server/test-support/fake-glide.ts` is the one stand-in for Glide. Three facts about it shape
the tests:

- It runs no business rule. `platform.refuses` (line 64) is a hook a test sets, called with
  `(table, row, operation)` on every insert, update and delete. A non-empty answer refuses the
  save. A test can put the new check there, to run it as the platform would run the rule.
- Its `GlideRecord` has no `setAbortAction`. So the entry functions that call `abortWith` with a
  refusal are not unit-tested. The tests call the platform functions, which return the refusal as
  text. This is the pattern of `closedPeriodRefusal` and `guardClosedBillingPeriod`.
- `recordOf(table, row, { fresh: true })` (line 461) gives a record that is not saved yet.

`platform/session.ts` keeps a user's scope and Customer per user id for as long as the module is
loaded, which in a test file is the whole file. So a test that needs another role signs in with a
user id that no other test of that file uses.

### Documentation that describes this today

```md
<!-- docs/verify-on-instance.md:374-382 -->
### Customer creates

`orders/access.now.ts`, `returns/access.now.ts`. As a customer admin, `POST /api/now/table/x_daas_ham_order` for another
Customer and `POST /api/now/table/x_daas_ham_order_line` are refused; a `POST` of a Return order
for another Customer is refused (this confirms the create rule sees the posted values); the
customer page's *Return selected* and the two record producers still work. As a service desk
agent (`sn_customerservice_agent` only), the order producer offers the Customer's Agreements and
Site templates, the generated Order opens with its lines and *Submit* goes ahead, and the return
producer opens the Return it raised.
```

```md
<!-- docs/adr/0005-visibility-by-before-query-rules.md:109-113 -->
(`margin/margin.now.ts`). Each Deny-Unless field ACL sits beside an Allow-If ACL of its own name (the platform's, or,
for `alm_asset.cost` write, one repeating `alm_asset.*`'s), so no verdict depends on how the platform matches ACLs
across levels. The app's own logic saves through GlideRecord, which no ACL checks.

## Consequences
```

```md
<!-- docs/adr/0005-visibility-by-before-query-rules.md:143-147 -->
- What only an instance can confirm (a Deny-Unless ACL with no role and a module function as its script, on a parent
  table, applying to its child table's records; *Applies To* on `alm_asset`; the row check on a New form; the field
  ACLs on `alm_asset` applying to an `alm_asset` list's hardware rows; a create rule's script seeing the posted values
  on a Table API insert) is checked in
  [docs/verify-on-instance.md](../verify-on-instance.md#access-and-visibility-adr-0005).
```

```md
<!-- docs/spec/p1-ordering.md:21-25 -->
- Through the record producer, an Order its requester may not raise is removed again (one the platform
  keeps is logged, to cancel). One that names records not of its Customer stays a draft with its lines
  (except those of a Site template not offered to the Customer), to correct and submit. So does one
  missing a line the platform refused: the user is told, and its work notes say, how many order lines
  were not saved, to add them and submit.
```

```md
<!-- docs/spec/p2-aftersales.md:81-85 -->
- Through the record producer, a return is raised only when the Return create rule lets its requester
  in (asset managers, account managers, NOC, the service desk and Customer admins): a Customer admin
  requests only for their own Customer, the others for any Customer, and site contacts never. The Site
  must be one of the Customer's Sites. Otherwise the request is removed again and the requester is
  told why (`domain/returns.ts` `returnRequestFindings`). The Site choices follow the chosen Customer.
```

### Conventions that apply (README.md "Development", AGENTS.md)

- `src/server/domain/` is pure. `src/server/platform/` holds the Glide services and never imports
  `entry/`. `src/server/entry/` holds thin trigger adapters, and no entry module imports another.
- A relative import in `src/server` names the `.ts` file. A `.now.ts` file imports without it.
- A function wired from Fluent names its parameters after the platform globals (`current`,
  `producer`). The SDK wrapper passes them by name.
- A `.now.ts` file holds constants, template literals and imports. No function call, loop, spread
  or array element.
- A new Fluent record takes `$id: Now.ID['<name>']`. `npm run build` adds the name to the tracked
  `src/fluent/generated/keys.ts`. Commit that file.
- The name of a business rule fits 40 characters.
- A test is a `*.test.ts` file beside its module, on `fake-glide.ts`.
- `npm test` needs `npm run build` first: `built-metadata.test.ts` fails when a source is newer
  than `dist/app`. `npx vitest run <path>` of another file needs no build.
- ATF tests run on an instance only (`docs/verify-on-instance.md#running-atf`).
- Use the words of `CONTEXT.md`: Customer, Customer contact, Site, Agreement, Order, Return order.

## Design decisions (already made, do not reopen)

- **One before-insert rule on each table, for a Customer contact's session only.** Provider staff,
  the service desk and jobs raise Orders and Returns for any Customer, and their drafts stay
  drafts to correct. The rule returns at once for them.
- **The rule runs for the app's own inserts too.** It does not try to recognise them. The checks
  only read, so running them twice is harmless, and every insert the app makes in a contact's
  session passes them: the customer page raises for the contact's own Customer and a Site it has
  just checked, and a swap-back takes the Customer and Site of an Order that passed *Submit*.
  Recognising the app's inserts would need a mark that reaches from the caller's script into the
  rule. `docs/research/external-contracts.md` N37 proved that for before-query rules only.
- **The Return rule does not judge who asks.** It calls `returnRequestFindings` with a requester
  that is "a contact of this Customer, let in": `{ mayRequest: true, scope: 'own_customer',
  customerId }`. Who may ask stays with the create ACL (a direct insert) and with `requestReturn`
  (the producer, the customer page). That is what lets a site contact's swap-back through
  (case 4 above). What the rule holds is what the record names: the contact's own Customer, and one
  of that Customer's Sites.
- **The Order rule runs `ownershipFindings` with the contact's real scope**, and `mayRaise: true`.
  A site contact raises no Order by any path, and `actorRefusal` refuses the scope `own_sites`.
- **The create ACLs do not change.** `canCreate()` of an empty Return order keeps passing for a
  customer admin: an ACL check runs no business rule. The customer page depends on that
  (`returnRequester` above).
- **A residue is accepted.** A customer admin can still insert, by hand, a Return order for their
  own Customer at one of its Sites, with a trigger and due date of their choosing and no line. It
  is their own Customer's record, and they may request a Return there anyway.
- **The producers' post-insert scripts stop when the record is not stored.** Whether the platform
  still runs a producer's post-insert script after a rule refused the insert is not known. The
  guard makes the answer not matter: without it `submitProducedOrder` would add order lines to an
  Order that does not exist.
- **No change to `fake-glide.ts`.** No `setAbortAction` is added to it.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| This plan's unit tests | `npx vitest run src/server/platform/returns.test.ts src/server/platform/order-submission.test.ts src/server/entry/orders.test.ts src/server/entry/returns.test.ts` | all pass (9, 9 and 3 tests at `805d5da`; the fourth file is new) |
| Neighbouring tests | `npx vitest run src/server/entry/visibility.test.ts src/server/entry/customer.test.ts src/server/domain` | all pass |
| Build | `npm run build` | exit 0; rewrites `dist/` and `src/fluent/generated/keys.ts` |
| Built-metadata tests | `npx vitest run src/server/built-metadata.test.ts` | all pass (75 tests at `805d5da`); needs a fresh build |
| Full gate | `npm run check` | exit 0 (1804 tests at `805d5da`) |

## Scope

**In scope** (the only files you should modify):

- `src/server/domain/visibility.ts` (export one function)
- `src/server/platform/records.ts` (add `isStored`)
- `src/server/platform/returns.ts`
- `src/server/platform/returns.test.ts`
- `src/server/platform/orders.ts`
- `src/server/platform/order-submission.test.ts`
- `src/server/entry/returns.ts`
- `src/server/entry/returns.test.ts` (create)
- `src/server/entry/orders.ts`
- `src/server/entry/orders.test.ts`
- `src/fluent/returns/logic.now.ts`
- `src/fluent/returns/access.now.ts` (one comment)
- `src/fluent/returns/tests.now.ts` (`customerReturnRequestTest` only)
- `src/fluent/orders/logic.now.ts`
- `src/fluent/generated/keys.ts` (rewritten by `npm run build`; never by hand)
- `docs/adr/0005-visibility-by-before-query-rules.md`
- `docs/verify-on-instance.md`
- `docs/spec/p1-ordering.md`
- `docs/spec/p2-aftersales.md`
- `plans/README.md` (your status row only)

**Out of scope** (do NOT touch, even though they look related):

- The create ACLs and their scripts: `Acl(...)` in `returns/access.now.ts` and
  `orders/access.now.ts`, `createsCustomerReturn` and `grantsCustomerRecord` in
  `entry/visibility.ts`, `grantsReturnOfOwnCustomer` in `domain/visibility.ts`. `canCreate()` of an
  empty Return order must keep passing.
- `src/server/domain/returns.ts`, `domain/entitlement.ts`, `domain/customer-parties.ts`. The
  findings are right. The rule calls them as they are.
- `requestReturn`, `raiseReturn`, `returnSwappedAssets`, `submitProducedOrder`, `createOrder`. No
  service changes what it checks or inserts.
- `src/server/entry/customer.ts` and the customer page.
- `src/server/test-support/fake-glide.ts`.
- Order lines and Return lines. A customer admin has no create ACL on either.
- `src/fluent/shared/visibility.now.ts`. The before-query rules do not change.

## Git workflow

- Branch: `advisor/032-customer-direct-insert-checks`, from `main`.
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example
  `Check a Customer contact's Order or Return order on any insert`. The body says what was wrong
  (the Site, Agreement and Customer checks ran only behind the record producers and the customer
  route), what the instance check of Step 1 showed, and whether the ATF test ran.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: The operator's instance check (a gate)

This step needs a ServiceNow instance with the app installed, and is the operator's to run. Never
run it on a production instance: it creates records. If you have no instance or no go-ahead, ask
the operator to run it and wait for the answer.

As a user who holds only `x_daas_ham.customer_admin` (with demo data: *Ada Acme (demo)*), signed in
or impersonated, send these three requests. Use the REST API Explorer or any HTTP client.

| Probe | Request | Body |
|---|---|---|
| A | `POST /api/now/table/x_daas_ham_return_order` | `{"short_description":"plan 032 probe A"}` |
| B | `POST /api/now/table/x_daas_ham_return_order` | `{"customer":"<their Customer's sys_id>","site":"<sys_id of a Site of another Customer>","trigger":"device_removal","short_description":"plan 032 probe B"}` |
| C | `POST /api/now/table/x_daas_ham_order` | `{"customer":"<their Customer's sys_id>","site":"<sys_id of a Site of another Customer>","short_description":"plan 032 probe C"}` |

Probe D: as the same user, open `x_daas_ham_return_order.do?sys_id=-1` and try to save a Return
order with no Customer. If the instance has a portal or CSM form on either table that Customer
contacts reach, try that too.

What decides it:

- **Any probe saves a record** (HTTP 201, or the form saves). The finding is live. Note which
  probes saved, then continue with Step 2.
- **Every probe is refused** (HTTP 401 or 403, the form does not open or does not save). A
  Customer contact cannot reach the insert on this instance. Do not change any code. Set this
  plan's row in `plans/README.md` to `REJECTED (Step 1: a Customer contact reaches no direct
  insert; responses: ...)`, with the status codes, and stop.

Afterwards the operator deletes the probe records as an administrator: Return orders and Orders
whose short description starts with `plan 032 probe`.

**Verify**: you have the result of probes A to D in writing, from the operator or from your own
run. With no result, see the STOP conditions.

### Step 2: Branch and confirm the baseline

```sh
git checkout main && git checkout -b advisor/032-customer-direct-insert-checks
npx vitest run src/server/platform/returns.test.ts src/server/platform/order-submission.test.ts src/server/entry/orders.test.ts
grep -rn "contactReturnInsertRefusal\|contactOrderInsertRefusal\|guardContactReturn\|guardContactOrder\|isStored" src
```

**Verify**: 21 tests pass, 0 failed. The `grep` prints nothing.

### Step 3: Write the failing tests

**3a. `src/server/platform/returns.test.ts`.**

Add this import as the first line of the file:

```ts
import type { GlideRecord } from '@servicenow/glide'
```

Replace the two import lines that read

```ts
import { chaseOverdue, raiseReturn, requestReturn } from './returns.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'
```

with

```ts
import { chaseOverdue, contactReturnInsertRefusal, raiseReturn, requestReturn, returnSwappedAssets } from './returns.ts'
import { platform, recordOf, type Row } from '../test-support/fake-glide.ts'
```

Append this block to the end of the file:

```ts

describe('a Return order saved in a Customer contact session', () => {
    // Users no other test of this file signs in as: a user's scope is kept for as long as the modules are loaded.
    const ADMIN = { id: 'direct-admin', name: 'Ada', company: 'acme', roles: ['x_daas_ham.customer_admin'], interactive: true }
    const SITE_CONTACT = { id: 'direct-contact', name: 'Sam', company: 'acme', roles: ['x_daas_ham.site_contact'], interactive: true }
    const STAFF = { id: 'direct-staff', name: 'Max', company: 'provider', roles: ['x_daas_ham.asset_manager'], interactive: true }
    const OWN_CUSTOMER = 'Return not raised. You can only request returns for your own customer.'

    const refusalOf = (row: Row) => contactReturnInsertRefusal(recordOf<GlideRecord>(RETURNS, row, { fresh: true }))

    /** Run the check on every insert of a Return order, as the platform runs the before-insert rule. */
    function withTheRule(): void {
        platform.refuses = (table, row, operation) => (table === RETURNS && operation === 'insert' ? (refusalOf(row) ?? '') : '')
    }

    beforeEach(() => {
        platform.creatable = () => true
        platform.defaults[RETURN_LINES] = () => ({ status: RETURN_LINE_STATUS.awaiting })
        platform.references = { [`${RETURN_LINES}.return_order`]: RETURNS, [`${RETURNS}.agreement`]: 'x_daas_ham_agreement' }
        platform.tables.cmn_location = [
            { sys_id: 'site1', name: 'HQ', company: 'acme', x_daas_ham_is_site: 'true' },
            { sys_id: 'site9', name: 'Elsewhere', company: 'other', x_daas_ham_is_site: 'true' },
        ]
        platform.tables.x_daas_ham_agreement = [{ sys_id: 'ag1', overdue_return_days: '10' }]
        platform.tables.alm_hardware = [{ ...unit('in_service'), company: 'acme' }]
    })

    it('is refused unless it names their own Customer and one of its Sites', () => {
        platform.user = ADMIN
        expect(refusalOf({})).toBe(OWN_CUSTOMER)
        expect(refusalOf({ customer: 'other', site: 'site9' })).toBe(OWN_CUSTOMER)
        expect(refusalOf({ customer: 'acme' })).toBe("Return not raised. Choose one of the customer's sites.")
        expect(refusalOf({ customer: 'acme', site: 'site9' })).toBe("Return not raised. The site is not one of the customer's sites.")
        expect(refusalOf({ customer: 'acme', site: 'site1' })).toBeNull()
    })

    it('is not checked when provider staff save it: they raise Returns for any Customer', () => {
        platform.user = STAFF
        expect(refusalOf({})).toBeNull()
        expect(refusalOf({ customer: 'other', site: 'site1' })).toBeNull()
    })

    it("passes the customer page's request, and refuses a Return raised for another Customer", () => {
        withTheRule()
        platform.user = ADMIN
        const requested = requestReturn({ customerId: 'acme', siteId: 'site1', decommission: false, listedAssetIds: ['a1'], method: 'ship_back', describe: (site) => `Return from ${site}` })
        expect(requested).toEqual({ raised: true, number: 'RET0002', lines: 1 })

        const theirs = raiseReturn({ trigger: 'device_removal', customerId: 'other', siteId: 'site9', agreementId: '', method: 'ship_back', assetIds: [], description: 'Not theirs' })
        expect(theirs).toBeNull()
        expect(rows(RETURNS).map((saved) => saved.customer)).toEqual(['acme'])
    })

    it("passes the swap-back a site contact's install confirmation raises: who asks is not the rule's to judge", () => {
        withTheRule()
        platform.user = SITE_CONTACT
        const order = recordOf<GlideRecord>('x_daas_ham_order', { sys_id: 'ord1', number: 'ORD0001', order_type: 'device_replace', customer: 'acme', site: 'site1', agreement: 'ag1', install_mode: 'self_install' })
        expect(returnSwappedAssets(order, ['a1'])).toEqual({ number: 'RET0002', lines: 1 })
        expect(rows(RETURNS).map((saved) => [saved.customer, saved.site, saved.trigger])).toEqual([['acme', 'site1', 'defective_return']])
    })
})
```

**3b. `src/server/platform/order-submission.test.ts`.**

Replace the two import lines that read

```ts
import { cancelOrder, submitOrder, submitProducedOrder, submitQueuedOrder } from './orders.ts'
```

and

```ts
import { platform, type Row } from '../test-support/fake-glide.ts'
```

with

```ts
import { cancelOrder, contactOrderInsertRefusal, submitOrder, submitProducedOrder, submitQueuedOrder } from './orders.ts'
```

and

```ts
import { platform, recordOf, type Row } from '../test-support/fake-glide.ts'
```

Append this block to the end of the file:

```ts

describe('an Order saved in a Customer contact session', () => {
    // Users no other test of this file signs in as: a user's scope is kept for as long as the modules are loaded.
    const ADMIN = { id: 'direct-admin', name: 'Ada', company: 'acme', roles: [ROLE.customerAdmin], interactive: true }
    const SITE_CONTACT = { id: 'direct-contact', name: 'Sam', company: 'acme', roles: [ROLE.siteContact], interactive: true }

    const refusalOf = (row: Row) => contactOrderInsertRefusal(recordOf<GlideRecord>(ORDERS, row, { fresh: true }))

    beforeEach(() => {
        rows('cmn_location').push({ sys_id: 'site9', company: 'other', x_daas_ham_is_site: 'true' })
        rows('x_daas_ham_agreement').push({ sys_id: 'agr9', customer: 'other' })
    })

    it('is refused unless it names their own Customer with an Agreement and a Site of that Customer', () => {
        platform.user = ADMIN
        expect(refusalOf({ customer: 'acme', site: 'site1', agreement: 'agr1' })).toBeNull()
        expect(refusalOf({})).toBe('Order not raised. You can only order for your own customer.')
        expect(refusalOf({ customer: 'other', site: 'site9', agreement: 'agr9' })).toBe('Order not raised. You can only order for your own customer.')
        expect(refusalOf({ customer: 'acme', site: 'site1' })).toBe("Order not raised. Choose one of the customer's agreements.")
        expect(refusalOf({ customer: 'acme', site: 'site9', agreement: 'agr9' })).toBe(
            "Order not raised. The agreement is not one of the customer's agreements. The site is not one of the customer's sites.",
        )
    })

    it('is refused for a site contact, who raises no Orders', () => {
        platform.user = SITE_CONTACT
        expect(refusalOf({ customer: 'acme', site: 'site1', agreement: 'agr1' })).toBe('Order not raised. You may not raise orders.')
    })

    it('is not checked when provider staff save it: their draft stays a draft to correct', () => {
        expect(refusalOf({})).toBeNull()
        expect(refusalOf({ customer: 'acme', site: 'site9', agreement: 'agr9' })).toBeNull()
    })
})
```

(The file's own `beforeEach` signs in the asset manager `am` and stores `site1` and `agr1`. The
last test relies on that.)

**3c. `src/server/entry/orders.test.ts`.**

In `produce`, store the Order before the script runs. Replace

```ts
    vi.mocked(submitProducedOrder).mockReturnValue(submission)
    afterOrderProduced({ devices: '' }, recordOf<GlideRecord>('x_daas_ham_order', { sys_id: 'order1', number: 'ORD0001' }))
```

with

```ts
    vi.mocked(submitProducedOrder).mockReturnValue(submission)
    platform.tables.x_daas_ham_order = [{ sys_id: 'order1', number: 'ORD0001' }]
    afterOrderProduced({ devices: '' }, recordOf<GlideRecord>('x_daas_ham_order', { sys_id: 'order1', number: 'ORD0001' }))
```

Add this test inside `describe('afterOrderProduced', ...)`, after its last test:

```ts

    it('does nothing for an Order that is not stored: a rule refused its insert and said why', () => {
        vi.mocked(submitProducedOrder).mockClear()
        afterOrderProduced({ devices: '' }, recordOf<GlideRecord>('x_daas_ham_order', { sys_id: 'order9', number: 'ORD0009' }))
        expect(submitProducedOrder).not.toHaveBeenCalled()
        expect(platform.messages).toEqual([])
    })
```

**3d. Create `src/server/entry/returns.test.ts`** with exactly this content:

```ts
import type { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { afterReturnProduced } from './returns.ts'
import { platform, recordOf } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

beforeEach(() => platform.reset())

describe('afterReturnProduced', () => {
    it('does nothing for a Return order that is not stored: a rule refused its insert and said why', () => {
        afterReturnProduced({ assets: 'a1' }, recordOf<GlideRecord>('x_daas_ham_return_order', { sys_id: 'ret9', customer: 'other', site: 'site9' }))
        expect(platform.messages).toEqual([])
        expect(platform.logs).toEqual([])
    })
})
```

**Verify**: `npx vitest run src/server/platform/returns.test.ts src/server/platform/order-submission.test.ts src/server/entry/orders.test.ts src/server/entry/returns.test.ts`
→ `9 failed | 21 passed`. The nine failures are exactly the nine new tests:

- the four of `a Return order saved in a Customer contact session` and the three of
  `an Order saved in a Customer contact session` (`... is not a function`: the check does not
  exist yet);
- `afterOrderProduced > does nothing for an Order that is not stored ...` (the script went on);
- `afterReturnProduced > does nothing for a Return order that is not stored ...` (the script went
  on, and the fake throws `fake Glide: canCreate is asked of x_daas_ham_return_order ...`).

The three older tests of `afterOrderProduced` still pass. If the set of failures differs, STOP.

### Step 4: Add the two checks to the platform layer

**4a. `src/server/domain/visibility.ts`.** Export `isCustomerContact`. Change line 217 from

```ts
function isCustomerContact(scope: VisibilityScope): boolean {
```

to

```ts
export function isCustomerContact(scope: VisibilityScope): boolean {
```

**4b. `src/server/platform/records.ts`.** Insert directly after `findById` (it ends on line 21):

```ts

/** Whether `record` is a stored row, read past the app's visibility rules: false for one a rule refused to insert. */
export function isStored(record: GlideRecord): boolean {
    return findById(record.getTableName(), record.getUniqueValue(), { beyondVisibility: true }) !== null
}
```

**4c. `src/server/platform/returns.ts`.**

Add this import after the import of `../domain/vocabulary.ts` (it ends on line 38):

```ts
import { isCustomerContact } from '../domain/visibility.ts'
```

Change line 53 from `import { creatorOf } from './session.ts'` to:

```ts
import { creatorOf, currentSession } from './session.ts'
```

Insert directly after `returnRequester` (it ends on line 354):

```ts

/**
 * Why the Return order `current`, about to be inserted, is refused, or null: the check of the before-insert rule
 * (entry/returns `guardContactReturn`). In a Customer contact's session it must name the contact's own Customer and
 * one of that Customer's Sites (domain/returns `returnRequestFindings`), whatever inserts it: the record producer, the
 * customer page, a form or the Table API. The customer admins' create ACL cannot hold a Return to that: it passes one
 * that names no Customer yet (domain/visibility `grantsReturnOfOwnCustomer`) and never looks at the Site.
 *
 * Who asks is not judged here: the create ACL and the services that raise a Return (`requestReturn`) decide that. So
 * the app's own inserts in a contact's session pass, a site contact's too: confirming a self-install raises the
 * swap-back of the units it replaced (`returnSwappedAssets`), for the Order's own Customer and Site. Anyone else
 * (provider staff, the service desk, a job) raises Returns for any Customer and is not checked.
 */
export function contactReturnInsertRefusal(current: GlideRecord): string | null {
    const { scope, customerId } = currentSession()
    if (!isCustomerContact(scope)) return null
    const siteId = str(current, 'site')
    const asContact: ReturnRequester = { mayRequest: true, scope: 'own_customer', customerId }
    const request = { customerId: str(current, 'customer'), site: requestedSite(siteId, findById('cmn_location', siteId)) }
    const [finding] = returnRequestFindings(request, asContact)
    return finding ? `Return not raised. ${finding.message}.` : null
}
```

`ReturnRequester`, `returnRequestFindings`, `findById` and `str` are imported already.

**4d. `src/server/platform/orders.ts`.**

Add this import after the import of `../domain/vocabulary.ts` (line 19):

```ts
import { isCustomerContact } from '../domain/visibility.ts'
```

Change line 35 from `import { creatorOf } from './session.ts'` to:

```ts
import { creatorOf, currentSession } from './session.ts'
```

Insert directly after `orderParties` (it ends on line 174):

```ts

/**
 * Why the Order `current`, about to be inserted, is refused, or null: the check of the before-insert rule
 * (entry/orders `guardContactOrder`). In a Customer contact's session it must pass what Submit checks
 * (domain/entitlement `ownershipFindings`): their own Customer, with an Agreement and a Site of that Customer and a
 * Site template offered to it, whatever inserts it: the record producer, a form or the Table API. The customer
 * admins' create ACL looks at the Customer only. Whether the create rule lets the contact in is that ACL's question,
 * and the producer's (`submitProducedOrder`); a site contact raises no Order. Anyone else (provider staff, the
 * service desk, a job) raises Orders for any Customer, and theirs stays a draft to correct.
 */
export function contactOrderInsertRefusal(current: GlideRecord): string | null {
    const { scope, customerId } = currentSession()
    if (!isCustomerContact(scope)) return null
    const findings = ownershipFindings(orderParties(current), { mayRaise: true, scope, customerId })
    return findings.length > 0 ? `Order not raised. ${findings.join('. ')}.` : null
}
```

In the doc comment of `submitProducedOrder` (lines 112-119), after the sentence that ends
`without the lines of a Site template not offered to it, and so does one` ... `sourced short of
what was asked for.`, add this sentence before the closing `*/`:

```ts
 * A Customer contact's Order that names records not its Customer's never gets here: the before-insert rule refuses it
 * (`contactOrderInsertRefusal`).
```

**Verify**: `npx vitest run src/server/platform/returns.test.ts src/server/platform/order-submission.test.ts`
→ 25 passed, 0 failed (13 and 12). `npm run typecheck` → exit 0.

### Step 5: Add the rule scripts and the post-insert guards to the entry layer

**5a. `src/server/entry/returns.ts`.** Replace lines 1-14 (the imports and `afterReturnProduced`)
with:

```ts
import { gs, type GlideRecord } from '@servicenow/glide'
import { isStored } from '../platform/records.ts'
import { contactReturnInsertRefusal, evaluateReturnLine, requestProducedReturn } from '../platform/returns.ts'
import { abortWith } from '../platform/rule-api.ts'

/**
 * Record producer "Return or decommission equipment" post-insert script. (`current` is
 * typed unknown because the SDK passes its own GlideRecord type here.)
 */
export function afterReturnProduced(producer: Record<string, unknown>, current: unknown): void {
    const order = current as GlideRecord
    // A rule that refused the insert has told the requester why (`guardContactReturn`). Whether the platform still
    // runs this script then is not known, and nothing is raised on a Return order that is not stored.
    if (!isStored(order)) return
    const listed = String(producer.assets ?? '')
        .split(',')
        .map((id) => id.trim())
    const outcome = requestProducedReturn(order, listed)
    if (!outcome.raised) gs.addErrorMessage(`Return not raised. ${outcome.why}.`)
}

/** Before-insert rule on Return orders: refuses one a Customer contact may not save as it stands. */
export function guardContactReturn(current: GlideRecord): void {
    abortWith(current, contactReturnInsertRefusal(current))
}
```

Leave `onReturnEvaluated` below it as it is.

**5b. `src/server/entry/orders.ts`.**

Change the import of `../platform/orders.ts` (lines 7-14) so that it also names
`contactOrderInsertRefusal`, first in the list:

```ts
import {
    cancelOrder,
    contactOrderInsertRefusal,
    rollUpOrderApprovals,
    submitOrder,
    submitProducedOrder,
    submitQueuedOrder,
    type Submission,
} from '../platform/orders.ts'
```

Change line 15 to:

```ts
import { isStored, str, type ForeignRecord } from '../platform/records.ts'
```

Add this import after it:

```ts
import { abortWith } from '../platform/rule-api.ts'
```

In `afterOrderProduced`, move the `const order = current as GlideRecord` line to the top of the
function and add the guard, so that the function starts:

```ts
export function afterOrderProduced(producer: Record<string, unknown>, current: unknown): void {
    const order = current as GlideRecord
    // A rule that refused the insert has told the requester why (`guardContactOrder`). Whether the platform still
    // runs this script then is not known, and no line is added to an Order that is not stored.
    if (!isStored(order)) return
    const asked = deviceRows(producer.devices)
```

The rest of the function follows unchanged, without its old `const order = current as GlideRecord`
line.

Add this function directly after `afterOrderProduced`:

```ts

/** Before-insert rule on Orders: refuses one a Customer contact may not save as it stands. */
export function guardContactOrder(current: GlideRecord): void {
    abortWith(current, contactOrderInsertRefusal(current))
}
```

**Verify**: `npx vitest run src/server/platform/returns.test.ts src/server/platform/order-submission.test.ts src/server/entry/orders.test.ts src/server/entry/returns.test.ts`
→ 30 passed, 0 failed. `npm run typecheck` → exit 0. `npm run lint` → exit 0.

### Step 6: Wire the two rules, extend the ATF test, and build

**6a. `src/fluent/returns/logic.now.ts`.** Change line 3 to:

```ts
import { guardContactReturn, onReturnEvaluated } from '../../server/entry/returns'
```

Insert directly after the `br_return_evaluated` rule (it ends on line 20):

```ts

/*
 * A Return order saved in a Customer contact's session names their own Customer and one of its Sites, whatever inserts
 * it: the record producer, the customer page, a form or the Table API (platform/returns `contactReturnInsertRefusal`).
 * The customer admins' create ACL cannot hold it to that: it passes a Return that names no Customer yet
 * (returns/access.now.ts) and never looks at the Site. The table is the app's own, so the script refuses with
 * current.setAbortAction (platform/rule-api `abortWith`).
 */
BusinessRule({
    $id: Now.ID['br_return_contact_insert'],
    name: "NaaS - check a contact's Return order",
    table: 'x_daas_ham_return_order',
    when: 'before',
    action: ['insert'],
    order: 100,
    script: guardContactReturn,
})
```

**6b. `src/fluent/orders/logic.now.ts`.** Change line 3 to:

```ts
import { guardContactOrder, onAllocatedAssetStageChange, onOrderApprovalDecision, sourceOrder, uiCancelOrder, uiRecheckApprovals, uiSubmitOrder } from '../../server/entry/orders'
```

Insert directly above the `br_order_approval_decision` rule (line 14), with one blank line after it:

```ts
/*
 * An Order saved in a Customer contact's session passes what Submit checks (their own Customer, with an Agreement and a
 * Site of that Customer), whatever inserts it: the record producer, a form or the Table API (platform/orders
 * `contactOrderInsertRefusal`). The customer admins' create ACL looks at the Customer only (orders/access.now.ts). The
 * table is the app's own, so the script refuses with current.setAbortAction (platform/rule-api `abortWith`).
 */
BusinessRule({
    $id: Now.ID['br_order_contact_insert'],
    name: "NaaS - check a contact's Order",
    table: 'x_daas_ham_order',
    when: 'before',
    action: ['insert'],
    order: 100,
    script: guardContactOrder,
})

```

**6c. `src/fluent/returns/access.now.ts`.** Replace the comment at lines 66-70 with:

```ts
/*
 * A customer admin creates a Return of their own Customer only. One that names no Customer yet passes: the customer
 * page asks whether a Return may be raised at all (canCreate() of an empty record) before it names
 * the Customer. What a Return then saved names (their own Customer, one of its Sites) is checked by the
 * before-insert rule (returns/logic.now.ts), which an ACL check does not run.
 */
```

Do not change the `Acl(...)` below it.

**6d. `src/fluent/returns/tests.now.ts`, in `customerReturnRequestTest`.**

1. Keep the second Site's sys_id. Change

   ```ts
           atf.server.recordInsert({
               $id: Now.ID['atf_crr_site_b'],
   ```

   to

   ```ts
           const siteB = atf.server.recordInsert({
               $id: Now.ID['atf_crr_site_b'],
   ```

2. Replace the test's `description` (the one string on the line after `description:`) with:

   ```ts
               "Calls the customer returns handler as a site contact (HTTP 403), then as a customer admin naming another Customer's site (HTTP 400) and their own site with decommission: true listing one of its two installed fleet assets (HTTP 201); both assets then await the return, so the site's equipment was found server-side. A Return order the admin then inserts by hand with no Customer, or with another Customer's site, is not saved, nor is such an Order; one for their own Customer and site is.",
   ```

3. Insert these steps directly after the closing `})` of the step
   `atf_crr_admin_requests` (the second `runServerSideScript`) and before the comment
   `// A customer reads no Asset's stage (fleet/access.now.ts), so the provider checks the outcome.`:

   ```ts
           // Still the customer admin. A record inserted by hand (a form, the Table API) meets the create ACL and no
           // producer: the before-insert rules hold it to the admin's Customer and its Sites. The last insert is the
           // control: it shows the admin can insert at all, so the three refusals are the rules'.
           atf.server.recordInsert({
               $id: Now.ID['atf_crr_insert_no_customer'],
               table: 'x_daas_ham_return_order',
               fieldValues: { short_description: 'ATF returns insert with no customer' },
               assert: 'record_not_inserted',
           })
           atf.server.recordInsert({
               $id: Now.ID['atf_crr_insert_other_site'],
               table: 'x_daas_ham_return_order',
               fieldValues: { customer: customerA.record_id, site: siteB.record_id, short_description: 'ATF returns insert with another site' },
               assert: 'record_not_inserted',
           })
           atf.server.recordInsert({
               $id: Now.ID['atf_crr_insert_order_other_site'],
               table: 'x_daas_ham_order',
               fieldValues: { customer: customerA.record_id, site: siteB.record_id, short_description: 'ATF order insert with another site' },
               assert: 'record_not_inserted',
           })
           atf.server.recordInsert({
               $id: Now.ID['atf_crr_insert_own_site'],
               table: 'x_daas_ham_return_order',
               fieldValues: { customer: customerA.record_id, site: siteA.record_id, short_description: 'ATF returns insert with their own site' },
               assert: 'record_successfully_inserted',
           })
   ```

**6e.** Run `npm run build`.

**Verify**:

- `npm run build` → exit 0.
- `git diff --numstat -- src/fluent/generated/keys.ts` → a first number above 0 and a second number
  of `0` (lines added, none deleted).
- `grep -c "br_return_contact_insert\|br_order_contact_insert\|atf_crr_insert_" src/fluent/generated/keys.ts`
  → `6`.
- `grep -l "check a contact" dist/app/update/sys_script_*.xml | wc -l` → `2`.
- `npx vitest run src/server/built-metadata.test.ts` → 75 passed, 0 failed. These tests now read
  the two new rules (their names fit 40 characters, their scripts name `current`) and the longer
  ATF description (at most 1000 characters).

### Step 7: Update the documents

The line numbers below are those of `805d5da`. Other plans add lines to these documents (plans 029
and 038 to `docs/spec/p2-aftersales.md` and `docs/verify-on-instance.md`), so find each place by
the text quoted in "Current state", not by its number.

**7a. `docs/adr/0005-visibility-by-before-query-rules.md`.**

Insert this paragraph after the line that ends `The app's own logic saves through GlideRecord,
which no ACL checks.` (line 111) and before `## Consequences`, with one blank line before and
after it:

```md
What a Customer contact creates is held to their Customer by a rule as well as an ACL. A customer admin's create ACL on
Orders and on Return orders checks the Customer the record names (`orders/access.now.ts`, `returns/access.now.ts`), and
the Return's passes a record that names none yet, as the customer page asks `canCreate()` of an empty record. No ACL
looks at the Site or the Agreement. So a before-insert rule on each table refuses, in a Customer contact's session, an
Order that fails what *Submit* checks (`domain/entitlement` `ownershipFindings`) and a Return order that names another
Customer, none, or a Site that is not its Customer's (`domain/returns` `returnRequestFindings`), whatever inserts it:
the record producer, the customer page, a form or the Table API (`platform/orders` `contactOrderInsertRefusal`,
`platform/returns` `contactReturnInsertRefusal`). The rule on Return orders does not judge who asks, which the create
ACL and the services do: a site contact's confirmation of a self-install raises the swap-back Return in their own
session. Provider staff, the service desk and jobs are not checked.
```

In the last bullet of `## Consequences`, replace

```md
  on a Table API insert) is checked in
```

with

```md
  on a Table API insert; the before-insert rules refusing a Customer contact's insert, through a record producer too)
  is checked in
```

**7b. `docs/verify-on-instance.md`.** In `### Customer creates`, add this paragraph after the one
that ends `producer opens the Return it raised.` (line 382), with one blank line before it:

```md
The before-insert rules (`returns/logic.now.ts`, `orders/logic.now.ts`). As a customer admin,
`POST /api/now/table/x_daas_ham_return_order` with no Customer, or with their Customer and another
Customer's Site, is refused with *Return not raised. ...* and saves nothing; with their own
Customer and Site it is saved. `POST /api/now/table/x_daas_ham_order` with their Customer and
another Customer's Site or Agreement is refused with *Order not raised. ...*. Through each record
producer, a request of theirs that names another Customer shows the refusal, opens no record and
leaves no Order line behind. As a site contact, *Confirm installed* on a self-install Order that
replaced a unit still raises the swap-back Return. The ATF test *NaaS - customer returns: admins
only, own sites only, a decommission takes the whole site* covers the inserts by hand.
```

**7c. `docs/spec/p1-ordering.md`.** Add this bullet after the bullet that ends
`were not saved, to add them and submit.` (line 25):

```md
- A Customer contact's Order is checked before it is saved, whatever inserts it (the record
  producer, a form or the Table API): one that fails the ownership rule above is refused with
  *Order not raised* and the reasons, and nothing is stored (`platform/orders.ts`
  `contactOrderInsertRefusal`). So only an Order raised by provider staff or the service desk stays
  a draft to correct.
```

**7d. `docs/spec/p2-aftersales.md`.** Add this bullet after the bullet that ends
`The Site choices follow the chosen Customer.` (line 85):

```md
- A Return order saved in a Customer contact's session is checked before it is saved, whatever
  inserts it (the record producer, the customer page, a form or the Table API): it must name the
  contact's own Customer and one of that Customer's Sites, else it is refused with *Return not
  raised* and the reason (`platform/returns.ts` `contactReturnInsertRefusal`). The swap-back Return
  that a site contact's install confirmation raises passes: it is for the Order's Customer and Site.
```

**Verify**:

- `grep -c "contactReturnInsertRefusal" docs/adr/0005-visibility-by-before-query-rules.md docs/spec/p2-aftersales.md` → `1` for each file
- `grep -c "contactOrderInsertRefusal" docs/adr/0005-visibility-by-before-query-rules.md docs/spec/p1-ordering.md` → `1` for each file
- `grep -c "The before-insert rules" docs/verify-on-instance.md` → `1`

### Step 8: Run the full gate and commit

```sh
npm run check
git status --short
```

**Verify**: `npm run check` exits 0. Vitest reports 0 failed and 9 more tests than before this plan
(1813 if nothing else landed since `805d5da`). `git status --short` lists only in-scope files,
`src/fluent/generated/keys.ts` and the new `src/server/entry/returns.test.ts` among them.

Commit them in one commit, with the subject from "Git workflow". The body says what was wrong, what
Step 1 showed, and that the ATF test has not run yet (or has, after Step 9).

### Step 9: Run it on an instance (only with the operator's go-ahead)

Skip this step if the operator gave you no development instance, or did not tell you to deploy to
one. Never run ATF on a production instance. If you skip it, set this plan's row in
`plans/README.md` to `DONE (instance run pending)`.

With a development instance and the go-ahead:

1. Install the build with `npm run deploy`.
2. Run suite **NaaS - P2** (`docs/verify-on-instance.md#running-atf`).
3. Work through the new paragraph of `### Customer creates` in `docs/verify-on-instance.md`.

**Verify**: the test *NaaS - customer returns: admins only, own sites only, a decommission takes
the whole site* passes, its four new insert steps included.

If a step fails, find it in this table, stop, and report it. Do not change the test or the app.

| What fails | What it means |
|---|---|
| `atf_crr_insert_no_customer`, `atf_crr_insert_other_site` or `atf_crr_insert_order_other_site`: the record was inserted | The rule did not refuse. Check that the rule is installed and active, and report the step |
| `atf_crr_insert_own_site`: the record was not inserted | The control failed. Either a customer admin cannot insert a Return order by hand at all (then the three refusals proved nothing, and Step 1's result is in doubt), or the rule refuses a Return it should pass |
| The script step `atf_crr_admin_requests` (it passed before this plan) | The rule refuses the customer page's own request. Report the step's output message |
| A producer still opens a record, or shows two messages, after the rule refused | Report what the producer showed. The post-insert guard is there for this case |

## Test plan

Unit tests, all on the fake Glide:

- `src/server/platform/returns.test.ts`, new `describe('a Return order saved in a Customer contact
  session', ...)`, 4 tests, modelled on that file's `a Customer admin's site decommission`:
  - a customer admin's record is refused with no Customer, another Customer, no Site, or another
    Customer's Site, and passes with their own Customer and Site (the regression this plan fixes);
  - provider staff are not checked;
  - with the check wired on every insert (`platform.refuses`), the customer page's request is
    raised, and a Return raised for another Customer is refused;
  - with the check wired, the swap-back in a site contact's session is raised.
- `src/server/platform/order-submission.test.ts`, new `describe('an Order saved in a Customer
  contact session', ...)`, 3 tests: the customer admin's cases, a site contact, provider staff.
- `src/server/entry/orders.test.ts`, 1 test added: the post-insert script does nothing for an Order
  that is not stored. The helper `produce` now stores its Order.
- `src/server/entry/returns.test.ts` (new), 1 test: the same for a Return order.
- Verification: `npx vitest run src/server/platform/returns.test.ts src/server/platform/order-submission.test.ts src/server/entry/orders.test.ts src/server/entry/returns.test.ts`
  → 30 passed (13, 12, 4 and 1).

Tests that must keep passing unchanged, because they hold what this plan must not break:

- `src/server/entry/visibility.test.ts`, `the customer admins' create ACLs`: `canCreate()` of an
  empty Return order passes.
- `src/server/entry/customer.test.ts`, `POST /customer/returns`.

ATF: four Record Insert steps added to `customerReturnRequestTest` in
`src/fluent/returns/tests.now.ts` (suite **NaaS - P2**). They run on an instance only.

What the unit tests cannot show. The fake Glide runs no business rule and has no
`setAbortAction`. That the two rules fire on a Table API insert, that the insert is refused with
the message, and what a record producer shows when its insert is refused, need an instance: Step 9.

## Done criteria

Local (these suffice to hand the work back). ALL must hold:

- [ ] Step 1's result is recorded in the commit body
- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm run check` exits 0, with 0 failed tests
- [ ] The unit test command in the test plan reports 30 passed
- [ ] `npx vitest run src/server/entry/visibility.test.ts src/server/entry/customer.test.ts` reports 0 failed
- [ ] `grep -c "br_return_contact_insert" src/fluent/returns/logic.now.ts` and `grep -c "br_order_contact_insert" src/fluent/orders/logic.now.ts` each print `1`
- [ ] `git diff main..HEAD -- src/fluent/returns/access.now.ts src/fluent/orders/access.now.ts | grep "^[-+] *\(script\|roles\|operation\):"` prints nothing (no ACL changed)
- [ ] `git diff --stat main..HEAD -- src/server/test-support src/server/domain/returns.ts src/server/domain/entitlement.ts src/server/entry/visibility.ts` prints nothing
- [ ] `git diff --numstat main..HEAD -- src/fluent/generated/keys.ts` shows lines added and `0` deleted
- [ ] `git status --short` is empty and only in-scope files differ from `main`
- [ ] `plans/README.md` status row updated

Instance only (the real proof; needs a development instance and the operator's go-ahead):

- [ ] Suite **NaaS - P2** passes, the four new insert steps included
- [ ] The new paragraph of `### Customer creates` in `docs/verify-on-instance.md` holds

## STOP conditions

Stop and report back (do not improvise) if:

- You have no result for Step 1 and the operator has not answered. Report `BLOCKED: awaiting the
  operator's instance check (Step 1)`. Go on without it only if the operator says in so many words
  to add the rules anyway, as a second line of defence. Then say so in the commit body.
- Step 1 shows every probe refused. The plan is REJECTED as Step 1 says. Change no code.
- The code at the locations in "Current state" does not match the excerpts.
- You find another place that inserts an Order or a Return order in a Customer contact's session
  (search `new GlideRecord('x_daas_ham_order')`, `new GlideRecord(RETURN)` and their callers). The
  list in "Who inserts these records" decided what the rules may refuse.
- Step 3 gives a different set of failing tests than the nine listed.
- After Step 4 or Step 5, the test `passes the swap-back a site contact's install confirmation
  raises` fails. Do not change the rule to recognise the app's inserts, and do not loosen the
  test. Report the failure message.
- A test fails with a message that starts with `fake Glide:`, or with a `TypeError` that names
  `setAbortAction` or another Glide method, other than the one failure Step 3 expects. Report it.
  Do not extend `fake-glide.ts`.
- `src/server/entry/visibility.test.ts` or `src/server/entry/customer.test.ts` fails. A create ACL
  or the customer page changed, which this plan must not do.
- `npm run build` reports an error or a new warning in a `.now.ts` file you edited, or
  `built-metadata.test.ts` fails after a fresh build. Report the test name and message. Do not edit
  an existing test of `built-metadata.test.ts`.
- After the build, `git diff --numstat -- src/fluent/generated/keys.ts` shows deleted lines.
- On an instance, any row of Step 9's table applies.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- New server logic that inserts an Order or a Return order in a Customer contact's session must
  name the contact's own Customer and, for a Return order, one of its Sites. Otherwise the rule
  refuses it: `raiseReturn` then returns null with a warning in the log. A swap-back for an Order
  whose Site has since moved to another Customer is such a case. Staff completing the install
  raises it, as staff are not checked.
- A new field that ties an Order or a Return order to a Customer's records (say a second Site)
  belongs in `ownershipFindings` or `returnRequestFindings`. The rules pick it up from there.
- A direct insert by a customer admin for their own Customer and one of its Sites is still saved,
  with whatever trigger and due date it names and no line. If that becomes a problem, the next
  step is to take the create ACL from customer admins and let the producers and the customer page
  insert past it. That changes `canCreate()` and the customer page, which is why it is not done
  here.
- The post-insert guards (`isStored`) cost one read for each produced record. If an instance check
  shows that the platform never runs a post-insert script after a refused insert, they can go.
- A reviewer should check four things: no `Acl(...)` changed, the Return rule passes
  `mayRequest: true` and the scope `own_customer` (the swap-back depends on it), `keys.ts` has
  additions only, and the commit body states Step 1's result.
- Deferred: the same question for the other tables a customer admin could be given a create ACL
  on. Today they have one on Orders and Return orders only (`grep -rn "customerAdmin" src/fluent --include='access.now.ts'`).
