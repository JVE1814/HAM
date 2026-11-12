# Plan 010: Refuse a customer page request that lists more than 5000 devices

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1864b17..HEAD -- src/server/entry/customer.ts src/server/entry/customer.test.ts src/server/domain/customer-requests.ts src/server/domain/customer-requests.test.ts docs/spec/p2-assurance.md`
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

Two routes of the customer page take an array from the request body and do one database read per
entry, with no limit on the array's length. `POST /customer/returns` reads each listed asset while
it holds the Customer's return-request lock, so one oversized request from a Customer admin's
session keeps the server busy and makes every other return request of that Customer answer *busy*.
`POST /customer/attestations/{id}` reads one attestation item per answer the same way. A list that
names one device many times also takes that device's return lock once per repeat.

After this plan both routes answer HTTP 400 for a list over 5000 entries, before any read, and a
return request reads each listed device once. The page itself never sends more than 5000, so no
honest request changes.

## Current state

Files and their roles:

- `src/server/entry/customer.ts`. The REST handlers of the customer page. Thin adapters over platform services.
- `src/server/entry/customer.test.ts`. Does not exist. You create it.
- `src/server/domain/customer-requests.ts` and its test. Do not exist. You create them for the pure cap rule.
- `src/server/platform/returns.ts`, `src/server/platform/attestations.ts`. The services that do the per-entry reads. Not changed.
- `docs/spec/p2-assurance.md`. The spec of the customer page's routes.

The attestation route passes the array through unbounded:

```ts
// src/server/entry/customer.ts:74-81
export function answerAttestation(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    if (!actsAsCustomerAdmin(currentSession().scope)) return reply(response, 403, { error: 'Only customer admins attest equipment' })
    const attestation = findUnclosedAttestation(pathParam(request, 'id'))
    if (!attestation) return reply(response, 404, { error: 'No open attestation' })
    const input = bodyOf<AttestationAnswers>(request)
    const refused = saveAttestationAnswers(attestation, Array.isArray(input.items) ? (input.items as AttestationAnswer[]) : [])
    if (refused > 0) return reply(response, 422, { error: `${refused} answer(s) not saved: the platform refused them` })
```

The service reads one item per answer:

```ts
// src/server/platform/attestations.ts:116-123
export function saveAttestationAnswers(attestation: GlideRecord, answers: readonly AttestationAnswer[]): number {
    let refused = 0
    for (const answer of answers) {
        if (!Object.keys(ATTESTATION_RESPONSE_CHOICES).includes(String(answer.response))) continue
        const item = findById(ITEM, String(answer.id ?? ''))
        if (!item || str(item, 'attestation') !== attestation.getUniqueValue()) continue
        item.setValue('response', String(answer.response))
        if (item.update()) continue
```

The returns route does the same with `assets`:

```ts
// src/server/entry/customer.ts:91-103
export function requestCustomerReturn(request: RESTAPIRequest, response: RESTAPIResponse): void {
    if (!allowed(response)) return
    const session = currentSession()
    if (!actsAsCustomerAdmin(session.scope)) return reply(response, 403, { error: 'Only customer admins can request returns' })
    const input = bodyOf<ReturnRequestBody>(request)
    const outcome = requestReturn({
        customerId: session.customerId,
        siteId: String(input.site ?? ''),
        decommission: input.decommission === true,
        listedAssetIds: (Array.isArray(input.assets) ? (input.assets as unknown[]) : []).map(String),
        method: input.method === 'fsm_deinstall' ? 'fsm_deinstall' : 'ship_back',
        describe: (siteName) => `Customer return request from ${siteName}`,
    })
```

The service reads each listed id, under the Customer's lock:

```ts
// src/server/platform/returns.ts:293
    const raised = withLock(LOCK.returnRequest(customerId), () => raiseRequested(request, site))
```

```ts
// src/server/platform/returns.ts:356-361
function fleetAssetsAt(siteId: string, listed: readonly string[]): string[] {
    return listed.filter((id) => {
        const asset = findById('alm_hardware', id)
        return !!asset && isFleetAsset(asset) && str(asset, 'x_daas_ham_site') === siteId && isDeployed(readStage(asset))
    })
}
```

The repo's precedent for a batch cap is the device events route. It is a pure domain decision that
returns an error text, and the entry adapter answers 400 with it:

```ts
// src/server/domain/device-events.ts:43-46
export function parseDeviceEvents(body: unknown, maxBatch: number, now: number): ParsedEvents {
    const raw = (body as { events?: unknown } | null)?.events
    if (!Array.isArray(raw)) return { error: 'Body must be { "events": [...] }' }
    if (raw.length > maxBatch) return { error: `At most ${maxBatch} events per request` }
```

Why 5000. The page lists only devices the server showed it:

- `customerEquipment` gives the page at most 5000 devices (`src/server/platform/customer-page.ts:37`, `asset.setLimit(5000)`).
- *Return selected* sends the devices chosen in one Site's grid (`src/client/customer/equipment.tsx:115`). *Decommission site* sends all of that Site's listed devices (`equipment.tsx:146`). Both are at most 5000.
- An attestation form sends one answer per item of one attestation (`src/client/customer/attestations.tsx:32-37`). An attestation has one item per device installed at one Site.

Repo conventions that apply (README.md "Development"):

- `domain/` holds pure rules and imports neither Glide nor `platform/` or `entry/`. The cap and the decision go there.
- `entry/` is a thin adapter. It reads inputs, calls a service, and reports the outcome in HTTP terms.
- A relative import in `src/server` names the `.ts` file (`'../domain/customer-requests.ts'`). Domain test files import their module without it (`'./customer-requests'`), as `src/server/domain/breakfix.test.ts:2` does.
- A test is a `*.test.ts` file beside the module it tests. An entry test runs against `src/server/test-support/fake-glide.ts` with stubbed request and response objects. `src/server/entry/shipping.test.ts:16-30` is the pattern.
- Every server module gets a `sys_module` key in the tracked file `src/fluent/generated/keys.ts` when `npm run build` runs. A new module adds one entry, and you commit that file. Test files get none.
- When documented behaviour changes, the matching spec lines change in the same commit.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 (needs plan 001; before it, use `npx eslint src`) |
| One test file | `npx vitest run <path>` | all pass |
| Build | `npm run build` | exit 0, rewrites `dist/` and `src/fluent/generated/keys.ts` |
| Full gate | `npm run check` | exit 0; typecheck, lint, build, then all tests |

`src/server/built-metadata.test.ts` fails when a file under `src/server` is newer than `dist/app`.
Run `npm run build` (or `npm run check`, which builds) before a full `npx vitest run`.

## Scope

**In scope** (the only files you should modify):

- `src/server/domain/customer-requests.ts` (create)
- `src/server/domain/customer-requests.test.ts` (create)
- `src/server/entry/customer.ts` (`answerAttestation` and `requestCustomerReturn` only, plus one import)
- `src/server/entry/customer.test.ts` (create)
- `docs/spec/p2-assurance.md` (one new paragraph after line 159)
- `src/fluent/generated/keys.ts` (only as rewritten by `npm run build`, never by hand)

**Out of scope** (do NOT touch, even though they look related):

- `src/server/platform/customer-page.ts`. Its `setLimit(5000)` is the source of the number, and plan 017 rewrites that line. Leave it.
- `src/server/platform/returns.ts` and `src/server/platform/attestations.ts`. The services stay as they are. Plan 005 edits `returns.ts`.
- `src/client/**`. The page never sends more than the cap.
- `reportFault`, `confirmInstalled`, and `customerOverview` in `entry/customer.ts`. They take no array.
- The record producer path (`requestProducedReturn`). Its list comes from a platform form variable, not from a REST body.
- A system property for the cap. A constant is enough, because the number follows from what the page is shown.

## Git workflow

- Branch: `advisor/010-customer-route-array-caps`
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example `Refuse a customer request listing more than 5000 devices`. Existing examples: `Refuse a server module that is not a .ts file`, `Hold BROAD_STAFF to PROVIDER_STAFF but the inventory tech`. The body says what was wrong and why.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the pure cap rule and its tests

Create `src/server/domain/customer-requests.ts` with exactly this content:

```ts
/**
 * The most devices one request of the customer page may list. The page lists devices it was shown: at most the 5000
 * of its equipment (platform/customer-page `customerEquipment`) in a return request, and the devices installed at one
 * Site in an attestation's answers. A handler reads a record for each entry, a return request while it holds its
 * Customer's return-request lock, so a longer list is refused unread.
 */
export const MAX_LISTED_DEVICES = 5000

export type SentList = { list: unknown[] } | { error: string }

/**
 * The list a customer page request names its devices in (the `assets` of a return request, the `items` of an
 * attestation's answers), as sent: anything but an array is an empty list, one over MAX_LISTED_DEVICES an error.
 */
export function sentDeviceList(raw: unknown): SentList {
    const list: unknown[] = Array.isArray(raw) ? raw : []
    if (list.length > MAX_LISTED_DEVICES) return { error: `At most ${MAX_LISTED_DEVICES} devices per request` }
    return { list }
}

/** The ids a sent list names, each once, in the order first named. */
export function uniqueIds(list: readonly unknown[]): string[] {
    return [...new Set(list.map(String))]
}
```

Create `src/server/domain/customer-requests.test.ts` with exactly this content. It follows
`src/server/domain/breakfix.test.ts`.

```ts
import { describe, expect, it } from 'vitest'
import { MAX_LISTED_DEVICES, sentDeviceList, uniqueIds } from './customer-requests'

describe('sentDeviceList', () => {
    it('gives the list as sent, up to the most a request may list', () => {
        expect(sentDeviceList(['a1', 'a2'])).toEqual({ list: ['a1', 'a2'] })
        expect(sentDeviceList(Array(MAX_LISTED_DEVICES).fill('a1'))).toMatchObject({ list: { length: MAX_LISTED_DEVICES } })
    })

    it('refuses a longer list', () => {
        expect(sentDeviceList(Array(MAX_LISTED_DEVICES + 1).fill('a1'))).toEqual({ error: 'At most 5000 devices per request' })
    })

    it('reads anything but an array as an empty list', () => {
        for (const sent of [undefined, null, 'a1', { length: 9000 }]) expect(sentDeviceList(sent)).toEqual({ list: [] })
    })
})

describe('uniqueIds', () => {
    it('names each id once, in the order first named', () => {
        expect(uniqueIds(['a2', 'a1', 'a2', 'a1', 'a3'])).toEqual(['a2', 'a1', 'a3'])
    })

    it('reads each entry as text', () => {
        expect(uniqueIds([7, '7', null])).toEqual(['7', 'null'])
    })
})
```

**Verify**: `npx vitest run src/server/domain/customer-requests.test.ts` → 5 tests pass.

### Step 2: Write the failing entry test

Create `src/server/entry/customer.test.ts` with exactly this content. The request and response
stubs follow `src/server/entry/shipping.test.ts:16-30`. The return fixture follows the
`describe("a Customer admin's device removal", ...)` block in `src/server/platform/returns.test.ts`.

```ts
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_LISTED_DEVICES } from '../domain/customer-requests.ts'
import { fieldsOf } from '../domain/lifecycle.ts'
import { RETURN_LINE_STATUS } from '../domain/vocabulary.ts'
import { answerAttestation, requestCustomerReturn } from './customer.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

/* The customer page's routes on the in-memory stand-in for the platform, called as a Customer admin. */

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const RETURNS = 'x_daas_ham_return_order'
const RETURN_LINES = 'x_daas_ham_return_order_line'
const ATTESTATIONS = 'x_daas_ham_attestation'
const ITEMS = 'x_daas_ham_attestation_item'
const LOCKS = 'x_daas_ham_job_lock'
const TOO_MANY = { status: 400, body: { error: 'At most 5000 devices per request' } }

const rows = (table: string): Row[] => platform.tables[table] ?? []

type Handler = (request: RESTAPIRequest, response: RESTAPIResponse) => void

function post(handler: Handler, body: object, pathParams: Record<string, string> = {}): { status: number; body: unknown } {
    const reply = { status: 0, body: null as unknown }
    const request = { body: { data: body }, pathParams, queryParams: {} } as unknown as RESTAPIRequest
    const response = {
        setStatus: (status: number) => void (reply.status = status),
        setBody: (sent: unknown) => void (reply.body = sent),
    } as unknown as RESTAPIResponse
    handler(request, response)
    return reply
}

beforeEach(() => {
    platform.reset()
    platform.user = { id: 'u1', name: 'Ada', company: 'acme', roles: ['x_daas_ham.customer_admin'], interactive: true }
    platform.uniqueKeys = { [LOCKS]: 'name' }
})

describe('POST /customer/returns', () => {
    const { installStatus, substatus } = fieldsOf('in_service')
    const requestReturn = (assets: unknown) => post(requestCustomerReturn, { site: 'site1', assets, decommission: false, method: 'ship_back' })

    beforeEach(() => {
        platform.creatable = () => true
        platform.defaults = { [RETURNS]: () => ({ number: 'RET0002' }), [RETURN_LINES]: () => ({ status: RETURN_LINE_STATUS.awaiting }) }
        platform.references = { [`${RETURN_LINES}.return_order`]: RETURNS, [`${RETURNS}.agreement`]: 'x_daas_ham_agreement' }
        platform.tables.cmn_location = [{ sys_id: 'site1', name: 'HQ', company: 'acme', x_daas_ham_is_site: 'true' }]
        platform.tables.x_daas_ham_agreement = [{ sys_id: 'ag1', overdue_return_days: '10' }]
        platform.tables.alm_hardware = [
            { sys_id: 'a1', serial_number: 'FOC111', x_daas_ham_fleet: 'true', company: 'acme', x_daas_ham_site: 'site1', x_daas_ham_agreement: 'ag1', install_status: installStatus, substatus: substatus ?? '' },
        ]
    })

    it('raises the Return for the devices listed, each once', () => {
        expect(requestReturn(['a1', 'a1'])).toEqual({ status: 201, body: { returnOrder: 'RET0002' } })
        expect(rows(RETURN_LINES).map((line) => line.asset)).toEqual(['a1'])
    })

    it('refuses a list longer than a request may name, and raises nothing', () => {
        expect(requestReturn(Array(MAX_LISTED_DEVICES + 1).fill('a1'))).toEqual(TOO_MANY)
        expect(rows(RETURNS)).toEqual([])
        expect(rows(RETURN_LINES)).toEqual([])
    })
})

describe('POST /customer/attestations/{id}', () => {
    const answer = (items: unknown) => post(answerAttestation, { items, submit: false }, { id: 'att1' })

    beforeEach(() => {
        platform.tables[ATTESTATIONS] = [{ sys_id: 'att1', number: 'ATT0001', state: '1' }]
        platform.tables[ITEMS] = [{ sys_id: 'item1', attestation: 'att1', asset: 'a1', response: '' }]
    })

    it('saves the answers given', () => {
        expect(answer([{ id: 'item1', response: 'confirmed' }])).toEqual({ status: 200, body: { attestation: 'ATT0001' } })
        expect(rows(ITEMS)[0]?.response).toBe('confirmed')
    })

    it('takes as many answers as a request may name', () => {
        const answers = Array(MAX_LISTED_DEVICES).fill({ id: 'item1', response: 'confirmed' })
        expect(answer(answers)).toEqual({ status: 200, body: { attestation: 'ATT0001' } })
    })

    it('refuses more, and saves none of them', () => {
        const answers = Array(MAX_LISTED_DEVICES + 1).fill({ id: 'item1', response: 'confirmed' })
        expect(answer(answers)).toEqual(TOO_MANY)
        expect(rows(ITEMS)[0]?.response).toBe('')
    })
})
```

Notes on the fixture. State `'1'` is an open attestation (`TASK_STATE.open` in
`src/server/domain/vocabulary.ts:26-33`). `'confirmed'` is a key of `ATTESTATION_RESPONSE_CHOICES`
(`vocabulary.ts:652-656`).

**Verify**: `npx vitest run src/server/entry/customer.test.ts` → 3 pass, 2 fail. The failures are:

- `POST /customer/returns > refuses a list longer than a request may name, and raises nothing`. Today's route raises a Return for `a1` and answers 201.
- `POST /customer/attestations/{id} > refuses more, and saves none of them`. Today's route saves the answers and answers 200.

The other three pass on today's code. They pin the behaviour that must not change.

### Step 3: Apply the cap in the two handlers

In `src/server/entry/customer.ts`:

1. Add this import directly above the `actsAsCustomerAdmin` import on line 12:

    ```ts
    import { sentDeviceList, uniqueIds } from '../domain/customer-requests.ts'
    ```

2. In `answerAttestation`, replace the `const refused = saveAttestationAnswers(...)` line (line 80) with:

    ```ts
        const answers = sentDeviceList(input.items)
        if ('error' in answers) return reply(response, 400, { error: answers.error })
        const refused = saveAttestationAnswers(attestation, answers.list as AttestationAnswer[])
    ```

3. In `requestCustomerReturn`, add these two lines directly after `const input = bodyOf<ReturnRequestBody>(request)` (line 95):

    ```ts
        const listed = sentDeviceList(input.assets)
        if ('error' in listed) return reply(response, 400, { error: listed.error })
    ```

4. In the same function, replace the `listedAssetIds:` line (line 100) with:

    ```ts
            listedAssetIds: uniqueIds(listed.list),
    ```

Keep the order of the existing checks. The role and Customer-admin checks (403) and the attestation
lookup (404) still come before the cap. Do not deduplicate the attestation answers: when two
answers name one item, the later one wins today, and that stays.

**Verify**:

- `npx vitest run src/server/entry/customer.test.ts src/server/domain/customer-requests.test.ts` → 10 tests pass.
- `npm run typecheck` → exit 0.
- `grep -n "Array.isArray" src/server/entry/customer.ts` → no matches.

### Step 4: Update the spec

In `docs/spec/p2-assurance.md`, the list that ends at line 159 reads:

```md
- `POST /customer/attestations/{id}` when an answer or the submission is refused, or the attestation
  is still pending or was cancelled, without submitting.
```

After that list item, add a blank line and this paragraph, wrapped at about 100 characters. Keep
the blank line before `New equipment is ordered through ...`.

```md
A return request (`assets`) or an attestation's answers (`items`) that lists more than
`MAX_LISTED_DEVICES` entries (`domain/customer-requests.ts`) answers HTTP 400 before anything is
read or saved: the page lists only devices it was shown, and it is shown no more than that. A
device a return request lists twice is read once.
```

**Verify**: `grep -n "MAX_LISTED_DEVICES" docs/spec/p2-assurance.md` → one match.

### Step 5: Build, run the gate, and commit

Run `npm run check`.

**Verify**: exit 0. The test summary shows no failed test. The count is the count before this plan
plus 10 (1596 when this plan runs directly on `1864b17` with plan 001).

Then run `git diff --stat -- src/fluent/generated/keys.ts`. Expect 4 added lines and no removed
line. `git diff -- src/fluent/generated/keys.ts` shows one new entry of this shape. The id is
generated and differs per build.

```ts
                    'src_server_domain_customer-requests_ts': {
                        table: 'sys_module'
                        id: '<generated>'
                    }
```

Run `git status --short`. Expect the six in-scope files and nothing else. Commit them with the
subject from "Git workflow".

## Test plan

- `src/server/domain/customer-requests.test.ts` (new, 5 tests), modelled on `src/server/domain/breakfix.test.ts`: a list at the cap passes, one over it is an error, a non-array is an empty list, ids are unique in first-named order, entries are read as text.
- `src/server/entry/customer.test.ts` (new, 5 tests), modelled on `src/server/entry/shipping.test.ts` for the stubs:
  - returns: a list naming one device twice raises one line (passes before and after);
  - returns: 5001 entries answer 400 and raise nothing (the regression);
  - attestation: one answer is saved (passes before and after);
  - attestation: exactly 5000 answers are taken (the boundary);
  - attestation: 5001 answers answer 400 and save nothing (the regression).
- The duplicate removal changes no response, because a device already on the Return was skipped before too. Only the domain test of `uniqueIds` observes it.
- No ATF test changes. The fake models everything this plan touches.
- Verification: `npx vitest run src/server/entry/customer.test.ts src/server/domain/customer-requests.test.ts` → 10 pass.

## Done criteria

All of these are local. None needs an instance.

- [ ] `npm run check` exits 0
- [ ] `npx vitest run src/server/entry/customer.test.ts src/server/domain/customer-requests.test.ts` → 10 tests pass
- [ ] `grep -n "Array.isArray" src/server/entry/customer.ts` returns no matches
- [ ] `grep -c "sentDeviceList(" src/server/entry/customer.ts` → `2`
- [ ] `git diff 1864b17 --stat -- src/fluent/generated/keys.ts` shows only added lines, and the diff contains `src_server_domain_customer-requests_ts`
- [ ] `git status --short` lists only the six in-scope files, all committed
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts.
- Step 2's run does not give exactly the two failures described. If all five pass, a cap already exists.
- A step's verification fails twice after a reasonable fix attempt.
- `npm run build` changes `src/fluent/generated/keys.ts` by more than the one added `sys_module` entry for `customer-requests.ts`, or removes a line. Do not edit that file by hand.
- You find a spec line, a test, or a fixture that expects a Site with more than 5000 installed devices, or a customer page that lists more than 5000. The cap assumes neither exists. An attestation for such a Site could then not be answered in one request.
- The fix seems to need a change in `src/server/platform/**` or `src/client/**`.

## Maintenance notes

- Overlap with plan 005 (`plans/005-decommission-visible-query.md`). Both plans change the customer return-request path, which runs from `requestCustomerReturn` in `src/server/entry/customer.ts` into `requestReturn` in `src/server/platform/returns.ts`. This plan edits `entry/customer.ts` and adds `entry/customer.test.ts`. Plan 005 edits `returns.ts` line 300 and `platform/installed-assets.ts`. No file is edited by both, so either order rebases without a conflict and neither plan's drift check lists the other's files. The return fixture in `entry/customer.test.ts` gives its asset `company: 'acme'`, the Customer of the signed-in user `u1`. Keep that in any decommission test added to the file, because after plan 005 a decommission leaves off a unit without the requester's company.
- Overlap with plan 017 (`plans/017-customer-equipment-grid.md`). It edits `customerOverview` in `entry/customer.ts` and replaces `setLimit(5000)` in `platform/customer-page.ts` with an `EQUIPMENT_LIMIT` constant. This plan adds one import line to `entry/customer.ts`, which moves the later line numbers down by one, and does not touch `customerOverview`. If the equipment limit is ever raised above 5000, raise `MAX_LISTED_DEVICES` with it, or *Decommission site* on a large Customer answers 400. A follow-up could make `customer-page.ts` read its limit from this constant so that the two cannot drift.
- Plan 012 (`plans/012-customer-routes-cross-tenant-atf.md`) adds ATF tests for the other customer routes. Its finding names no edit to `entry/customer.ts`.
- The attestation form sends every item of one attestation in one request. The cap is therefore also the most devices one Site can attest at once. If Sites grow past it, send the answers in batches from `src/client/customer/attestations.tsx` and keep the cap.
- A reviewer should check that the cap is applied before `requestReturn` takes the return-request lock, and that both 403 checks still run first.
