# Plan 014: Assign a GreenLake subscription only to the device whose serial was asked for

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1864b17..HEAD -- src/server/domain/oem/claim-adapters.ts src/server/domain/oem/claims.test.ts src/server/platform/rest-messages.ts src/fluent/oem/rest-messages.now.ts docs/spec/p3-integrations.md`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-lint-tracked-sources.md
- **Category**: security
- **Planned at**: commit `1864b17`, 2026-11-12

## Why this matters

To license an Aruba device, the app asks HPE GreenLake for the device with a given serial, takes the first device of the answer, and assigns the Customer's subscription to it. It never checks that the device answered is the one asked for. The serial is also put into a quoted filter string with its quotes unescaped, so a serial that holds a `'` changes the filter (for example to one that matches every device). Either way, one Customer's paid subscription can land on another Customer's device in the Provider's workspace, and the staging step is ticked as done. Serials come from ASN files and staff entry, checked only for being non-empty. After this plan the adapter assigns only to a device GreenLake returns with the serial asked for, and writes a quote in the serial the way the filter's string syntax requires.

## Current state

Files and their roles:

- `src/server/domain/oem/claim-adapters.ts`: the OEM claim adapters, pure TypeScript (no Glide). `greenLakeSubscribe` is the one to change.
- `src/server/domain/oem/claims.test.ts`: the adapters' unit tests, with a fake transport. New tests go here, and one helper changes.
- `src/server/domain/serials.ts`: `normalizeSerial`, how the app compares serials. Not modified.
- `src/server/platform/rest-messages.ts`: the transport that URL-encodes parameters. Not modified.
- `src/fluent/oem/rest-messages.now.ts`: the REST message whose endpoint holds the filter. Not modified.
- `docs/spec/p3-integrations.md`: the spec row that describes the subscription step.

The adapter, `src/server/domain/oem/claim-adapters.ts:136-165`:

```ts
/**
 * HPE GreenLake: find the device by serial, then PATCH its subscription.
 * The PATCH is asynchronous (202), so a device found already carrying the subscription id is done without a PATCH:
 * a re-run confirms the assignment.
 */
const greenLakeSubscribe: ClaimAdapter = (targets, http, maxCalls) => {
    const { usable, outcomes } = unusable(targets, 'serial')
    let calls = 0
    for (const t of usable) {
        if (calls + GREENLAKE_SUBSCRIBE_CALLS > maxCalls) break
        const found = http({ fn: REST_MESSAGE.greenLake.fn.findDevice, params: { serial: t.serial } })
        if (found === LOCK_LOST) break
        calls++
        const device = isSuccess(found.status) ? asArray(field(parseJson(found.body), 'items'))[0] : undefined
        const deviceId = text(field(device, 'id'))
        if (!deviceId) {
            outcomes.push({ stepId: t.stepId, ok: false, message: isSuccess(found.status) ? 'device not in the GreenLake workspace yet' : failureText(found) })
            continue
        }
        if (asArray(field(device, 'subscription')).some((s) => text(field(s, 'id')).toLowerCase() === t.account.toLowerCase())) {
            outcomes.push({ stepId: t.stepId, ok: true, message: `subscription ${t.account} assigned` })
            continue
        }
        const assigned = http({ fn: REST_MESSAGE.greenLake.fn.assignSubscription, params: { device_id: deviceId }, body: JSON.stringify({ subscription: [{ id: t.account }] }) })
        if (assigned === LOCK_LOST) break
        calls++
        outcomes.push(outcome(t, assigned, `subscription ${t.account} assigned`))
    }
    return { outcomes, calls }
}
```

`[0]` on line 149 is the unchecked pick. Line 159 PATCHes that device.

The file already imports everything the fix needs (lines 1-4):

```ts
import { normalizeSerial } from '../serials.ts'
import { chunks } from '../collections.ts'
import { failureText, isSuccess, type HttpResponse } from '../http.ts'
import { asArray, field, isJsonObject, parseJson, text } from '../json.ts'
```

The same file's Meraki adapter already compares returned serials the app's way, lines 76-78. Match it:

```ts
        const claimed = new Set(asArray(returned).map((s) => normalizeSerial(text(s))))
        for (const t of batch) {
            const done = !Array.isArray(returned) || claimed.has(normalizeSerial(t.serial))
```

`normalizeSerial`, `src/server/domain/serials.ts:5-7`:

```ts
export function normalizeSerial(serial: string): string {
    return serial.trim().toUpperCase()
}
```

`text(value)` (`src/server/domain/json.ts:32-34`) returns a trimmed string, or `''` for anything that is not a string or a number. `field(value, key)` returns `undefined` when `value` is not an object.

The endpoint, `src/fluent/oem/rest-messages.now.ts:181-186`:

```ts
        {
            name: REST_MESSAGE.greenLake.fn.findDevice,
            httpMethod: 'GET',
            endpoint: `${GREENLAKE}/devices/v1/devices?filter=serialNumber eq '\${serial}'`,
            variables: [{ $id: Now.ID['rm_greenlake_serial'], name: 'serial' }],
        },
```

The transport, `src/server/platform/rest-messages.ts:79`:

```ts
            for (const [name, value] of Object.entries(request.params)) rest.setStringParameterNoEscape(name, encodeURIComponent(value).replace(/%2C/g, ','))
```

`encodeURIComponent` does not encode `'`. Checked at planning time: `encodeURIComponent("A' or serialNumber ne '")` gives `A'%20or%20serialNumber%20ne%20'`. So the quote reaches GreenLake as a quote and ends the string literal.

What the vendor contract says, `docs/research/external-contracts.md:412-418`:

```
- **GreenLake find device.** operationId `getDevicesV1`; query parameters `filter` (OData 4.0 subset;
  example `serialNumber eq 'STIAPL6404'`), `filter-tags`, `sort`, `select`, `limit` (max and default
  2000) and `offset`. The 200 response requires `items` and `count` (plus `offset`, `total`); each item
  requires `id` (uuid), `partNumber`, `serialNumber` and `type`; `item.subscription[]` has `id` (uuid),
  `key`, `tier` and more. Rate limit 160 requests per minute per workspace; needs
  `ccs.device-management.view`. The guide says reserved characters in string literals must be
  percent-encoded.
```

So every item carries a `serialNumber` to compare, and the filter is OData. In OData 4.0 a quote inside a quoted string is written as two quotes. Whether GreenLake's subset accepts a doubled quote is not verified; a real serial holds no quote, and the serial comparison is what guarantees the result either way.

The same document lists an open item about this URL, lines 1443-1444. This plan does not change the endpoint, so the item stays open as it is:

```
- GreenLake: whether RESTMessageV2 accepts the unencoded spaces and quotes in the `find_device` filter
  URL.
```

The existing tests, `src/server/domain/oem/claims.test.ts`. Helpers at the top of the file (lines 26-44):

```ts
function fake(responses: Array<HttpResponse | ((request: HttpRequest) => HttpResponse)>) {
    const calls: HttpRequest[] = []
    let i = 0
    const http = (request: HttpRequest): HttpResponse => {
        calls.push(request)
        const next = responses[Math.min(i++, responses.length - 1)]
        return typeof next === 'function' ? next(request) : next
    }
    return { http, calls }
}

const target = (stepId: string, overrides: Partial<ClaimTarget> = {}): ClaimTarget => ({
    stepId,
    serial: `Q2XX-${stepId}`,
    mac: '00:11:22:33:44:55',
    claimCode: `CODE${stepId}`,
    account: 'org1',
    ...overrides,
})
```

Inside `describe('GreenLake', ...)` (lines 165-233), the fixtures at lines 175-187 and the last test at lines 227-232:

```ts
    /** postDevicesV1 202: progress at the Location URL; body { code, status, transactionId }. */
    const accepted = { status: 202, body: JSON.stringify({ code: 202, status: 'Accepted', transactionId: 'tx-1' }) }
    const SUB = '6b1a3b8e-0c1d-4c3e-9f7a-2d5e8b9c0a11'
    /** getDevicesV1 200: { items: [{ id, serialNumber, partNumber, type, subscription: [{ id, key, tier }] }], count, offset, total }. */
    const devices = (subscription: Array<{ id: string; key: string; tier?: string }> = []) => ({
        status: 200,
        body: JSON.stringify({
            items: [{ id: 'f3c1b2a0-1111-4222-8333-444455556666', serialNumber: 'Q2XX-A', partNumber: 'R4W02A', type: 'devices/device', subscription }],
            count: 1,
            offset: 0,
            total: 1,
        }),
    })
```

```ts
    it('waits while the device is not in the workspace yet', () => {
        const { http } = fake([{ status: 200, body: JSON.stringify({ items: [] }) }])
        expect(GREENLAKE_SUBSCRIBE.run([target('A')], http, 5).outcomes).toEqual([
            { stepId: 'A', ok: false, message: 'device not in the GreenLake workspace yet' },
        ])
    })
})
```

`devices()` answers with serial `Q2XX-A`, which is `target('A')`'s serial, so the existing GreenLake tests keep passing after the fix.

One shared helper answers `find_device` with a device that has no serial, lines 369-375. Two `runVendorClaims` tests depend on it (`loads enough of the due steps ... (aruba oem_licence, 8 calls)` at line 394 and `adds Aruba devices before assigning subscriptions, from one shared budget` at line 401). It must echo the serial asked for, or those two tests fail after the fix:

```ts
/** Answers every vendor function with success (GreenLake finds the device, Zero Touch logs in, FortiCloud status 0). */
const succeed = (request: HttpRequest): HttpResponse =>
    request.fn === 'find_device'
        ? { status: 200, body: JSON.stringify({ items: [{ id: 'dev-1' }] }) }
        : request.fn === 'login'
          ? { status: 200, body: JSON.stringify({ sid: 'sid-1' }) }
          : { status: 200, body: JSON.stringify({ status: 0 }) }
```

The spec row, `docs/spec/p3-integrations.md:125` (third cell is the subscription step):

```
| Aruba (GreenLake) | add device by serial + **MAC** to the Provider's workspace, a capped number per call (`GREENLAKE_ADD_BATCH` in `domain/oem/claim-adapters.ts`; `network`, with `compute` and `storage` empty) | find the device, assign the Customer's subscription (merge-patch JSON); a device already carrying it counts as done | — |
```

Conventions that apply (from `README.md` "Development"):

- `src/server/domain/` is pure: it imports neither Glide nor `platform/` or `entry/`. This plan stays inside it.
- A relative import in a `src/server` module names the `.ts` file (`'../serials.ts'`). Test files import without the extension. This plan adds no import.
- A test is a `*.test.ts` file beside its module.
- `src/server/built-metadata.test.ts` fails when any `src/server` source (tests aside) is newer than `dist/app`. After editing `claim-adapters.ts`, the full test run needs `npm run build` first. `npm run check` does that in order. `npx vitest run src/server/domain` works without a build.
- Comments only for a non-obvious why.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| This test file | `npx vitest run src/server/domain/oem/claims.test.ts` | all pass (77 tests at `1864b17`) |
| Domain tests, no build | `npx vitest run src/server/domain` | all pass (1243 tests at `1864b17`) |
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 (needs plan 001; before it, use `npx eslint src`) |
| Full gate | `npm run check` | typecheck, lint, build and vitest all pass (1586 tests at `1864b17`) |

## Scope

**In scope** (the only files you should modify):

- `src/server/domain/oem/claim-adapters.ts` (the `greenLakeSubscribe` function only)
- `src/server/domain/oem/claims.test.ts`
- `docs/spec/p3-integrations.md` (line 125 only)

**Out of scope** (do NOT touch, even though they look related):

- `src/fluent/oem/rest-messages.now.ts`: the endpoint and its unencoded spaces and quotes are an open instance question (`external-contracts.md:1443`). Changing the URL here would mix an unverified platform change into this fix.
- `src/server/platform/rest-messages.ts`: the transport's encoding is shared by every vendor. The quote rule belongs to the one caller that puts a value into an OData string.
- `docs/research/external-contracts.md`: a dated record of what was checked against the vendors' documents, not a description of the current code (its row for "GreenLake add devices" still says 25 per call).
- `greenLakeAdd` and the other adapters. FortiZTP's `devices/${serial}` puts the serial in a URL path, where `encodeURIComponent` already encodes `/`, `?` and `#`.
- `unusable()`, `normalizeSerial`, and serial validation at ASN import (`domain/asn.ts`). Tightening what a serial may hold is a separate change with its own callers.
- `src/fluent/generated/keys.ts`: `npm run check` rebuilds it, and it must come out unchanged. If it changes, see STOP conditions.

## Git workflow

- Branch: `advisor/014-greenlake-serial-match`
- One commit. Subject in the repo's style (imperative sentence under 72 characters), for example: `Assign a GreenLake subscription only to the serial asked for`. The body says what was wrong (the first device of the answer was taken unchecked, and a quote in the serial changed the filter) and why it matters (a Customer's subscription could go to another device).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing tests

In `src/server/domain/oem/claims.test.ts`, inside `describe('GreenLake', ...)`, add these four tests directly after the test `waits while the device is not in the workspace yet` (ends at line 232) and before the `})` that closes the `describe` (line 233):

```ts
    it('assigns nothing when the device GreenLake answers with has another serial', () => {
        const { http, calls } = fake([devices(), accepted])
        const result = GREENLAKE_SUBSCRIBE.run([target('B', { account: SUB })], http, 5)
        expect(calls.map((c) => c.fn)).toEqual(['find_device'])
        expect(result).toEqual({ outcomes: [{ stepId: 'B', ok: false, message: 'GreenLake found another device for this serial: nothing assigned' }], calls: 1 })
    })

    it('takes, of several devices, the one with the serial asked for, compared as the app compares serials', () => {
        const body = JSON.stringify({ items: [{ id: 'other', serialNumber: 'Q2XX-B' }, { id: 'mine', serialNumber: ' q2xx-a ' }] })
        const { http, calls } = fake([{ status: 200, body }, accepted])
        GREENLAKE_SUBSCRIBE.run([target('A', { account: SUB })], http, 5)
        expect(calls.map((c) => c.fn)).toEqual(['find_device', 'assign_subscription'])
        expect(calls[1]).toMatchObject({ params: { device_id: 'mine' } })
    })

    it('never takes a device that names no serial, even for a blank serial', () => {
        const { http, calls } = fake([{ status: 200, body: JSON.stringify({ items: [{ id: 'dev-1' }] }) }, accepted])
        const result = GREENLAKE_SUBSCRIBE.run([target('A', { serial: ' ', account: SUB })], http, 5)
        expect(calls.map((c) => c.fn)).toEqual(['find_device'])
        expect(result.outcomes).toEqual([{ stepId: 'A', ok: false, message: 'GreenLake found another device for this serial: nothing assigned' }])
    })

    it("doubles a quote in the serial, so it stays inside the filter's string literal", () => {
        const { http, calls } = fake([{ status: 200, body: JSON.stringify({ items: [] }) }])
        GREENLAKE_SUBSCRIBE.run([target('A', { serial: "X' or serialNumber ne '" })], http, 5)
        expect(calls[0]).toMatchObject({ fn: 'find_device', params: { serial: "X'' or serialNumber ne ''" } })
    })
```

**Verify**: `npx vitest run src/server/domain/oem/claims.test.ts` → `4 failed | 77 passed (81)`. The four failures are the four new tests. (This red result was reproduced at planning time on a scratch copy.)

### Step 2: Match the device by serial and double the quote

In `src/server/domain/oem/claim-adapters.ts`, inside `greenLakeSubscribe`, replace lines 146-154 (from `const found = http(...)` through the closing `}` of `if (!deviceId) { ... }`) with:

```ts
        // The serial sits in a quoted OData string of the filter, where a quote is written twice; the transport's URL
        // encoding leaves a quote as it is.
        const found = http({ fn: REST_MESSAGE.greenLake.fn.findDevice, params: { serial: t.serial.replace(/'/g, "''") } })
        if (found === LOCK_LOST) break
        calls++
        if (!isSuccess(found.status)) {
            outcomes.push({ stepId: t.stepId, ok: false, message: failureText(found) })
            continue
        }
        // Only a device answered with the serial asked for is the Asset's: the subscription is the Customer's.
        const wanted = normalizeSerial(t.serial)
        const items = asArray(field(parseJson(found.body), 'items'))
        const device = items.find((item) => wanted !== '' && normalizeSerial(text(field(item, 'serialNumber'))) === wanted)
        const deviceId = text(field(device, 'id'))
        if (!deviceId) {
            const message = items.length > 0 && !device ? 'GreenLake found another device for this serial: nothing assigned' : 'device not in the GreenLake workspace yet'
            outcomes.push({ stepId: t.stepId, ok: false, message })
            continue
        }
```

Leave everything else in the function as it is: the budget check before the call, the "already carries the subscription" branch, the PATCH, and `return { outcomes, calls }`. Add no import and no helper function.

What each outcome now means:

| GreenLake's answer to `find_device` | Outcome |
|---|---|
| not 2xx, or no answer | failed with `failureText(found)` (unchanged) |
| 2xx, no items, or a body that is not JSON | failed, `device not in the GreenLake workspace yet` (unchanged) |
| 2xx, items, none with the serial asked for | failed, `GreenLake found another device for this serial: nothing assigned` (new) |
| 2xx, an item with the serial asked for | as before: done if it carries the subscription, else PATCH |

**Verify**: `npx vitest run src/server/domain/oem/claims.test.ts` → `2 failed | 79 passed (81)`. The two failures are exactly `runVendorClaims > loads enough of the due steps to make every call it is allowed (aruba oem_licence, 8 calls)` and `runVendorClaims > adds Aruba devices before assigning subscriptions, from one shared budget`. They fail because the `succeed` helper answers with a device that has no serial. Step 3 fixes the helper. Any other failure is a STOP condition.

### Step 3: Make the shared test helper answer with the serial asked for

In `src/server/domain/oem/claims.test.ts`, in `succeed` (lines 370-375), change the `find_device` line to:

```ts
        ? { status: 200, body: JSON.stringify({ items: [{ id: 'dev-1', serialNumber: request.params.serial }] }) }
```

Change nothing else in the helper or in the two tests that use it.

**Verify**:

- `npx vitest run src/server/domain/oem/claims.test.ts` → `81 passed (81)`
- `npx vitest run src/server/domain` → all pass (1247 tests: 1243 at `1864b17` plus 4)

### Step 4: Update the spec row

In `docs/spec/p3-integrations.md` line 125, replace the third cell's text

```
find the device, assign the Customer's subscription (merge-patch JSON); a device already carrying it counts as done
```

with

```
find the device by its serial (only a device GreenLake returns with that serial counts as found; any other assigns nothing and fails the step), assign the Customer's subscription (merge-patch JSON); a device already carrying it counts as done
```

Keep the row on one line and leave the other cells as they are.

**Verify**: `grep -c "only a device GreenLake returns with that serial counts as found" docs/spec/p3-integrations.md` → `1`

### Step 5: Run the full gate and commit

Run `npm run check`.

**Verify**: exit 0. Vitest reports 1590 tests passed (1586 at `1864b17` plus 4; more if other plans landed first, but none failed). Then `git status --short` lists exactly the three in-scope files. Commit them.

## Test plan

- New tests in `src/server/domain/oem/claims.test.ts`, in `describe('GreenLake', ...)`:
  - an answer whose only device has another serial assigns nothing and fails the step with the new message (the regression this plan fixes);
  - among several devices, the one with the serial asked for is taken, compared trimmed and without case;
  - a device with no `serialNumber` is never taken, even when the Asset's serial is blank after trimming;
  - a quote in the serial is doubled in the `serial` parameter sent to the transport.
- Changed helper: `succeed` echoes the serial asked for, as GreenLake's contract says every item carries one.
- Structural pattern: the existing tests in the same `describe`, for example `assigns the subscription after finding the device, two calls each` (line 204).
- What the tests cannot show: how GreenLake itself answers a filter with a doubled quote, and whether `RESTMessageV2` accepts the URL. The fake transport records the parameter and returns canned answers. Both are instance checks already listed in `docs/verify-on-instance.md` ("Vendor contracts", "REST messages").
- Verification: `npx vitest run src/server/domain/oem/claims.test.ts` → `81 passed (81)`.

## Done criteria

All local. No instance is needed to hand this work back.

- [ ] `npm run check` exits 0
- [ ] `npx vitest run src/server/domain/oem/claims.test.ts` reports `81 passed (81)`
- [ ] `grep -n "'items'))\[0\]" src/server/domain/oem/claim-adapters.ts` returns no match
- [ ] `grep -c "GreenLake found another device for this serial" src/server/domain/oem/claim-adapters.ts` returns `1`
- [ ] `git status --short` shows only `src/server/domain/oem/claim-adapters.ts`, `src/server/domain/oem/claims.test.ts` and `docs/spec/p3-integrations.md`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts, in particular if `greenLakeSubscribe` no longer takes `asArray(...)[0]`.
- After step 1, fewer or more than the four new tests fail. An existing test failing means the file has drifted.
- After step 2, a test other than the two named `runVendorClaims` tests fails.
- After step 3, any test in `src/server/domain` fails. Do not change an expected value in an existing test to make it pass; report the test and its output.
- `npm run check` leaves `src/fluent/generated/keys.ts` modified. This plan adds no Fluent record, so a diff there comes from something else.
- You find yourself wanting to change `src/fluent/oem/rest-messages.now.ts` or `src/server/platform/rest-messages.ts` to make a test pass. The fix does not need either.
- On an instance, GreenLake answers a real serial's look-up with a `serialNumber` in another form than the Asset's (extra prefix, different separator), so genuine devices now fail with the new message. Report the two values. Do not loosen the comparison by guesswork.

## Maintenance notes

- The comparison assumes GreenLake returns `serialNumber` as the serial the app stores, up to case and surrounding spaces. The vendor contract makes the field required but says nothing about its form. If steps fail with `GreenLake found another device for this serial`, compare the Asset's serial with the device's in the GreenLake workspace first.
- A step that fails this way is retried like any failed step (`RETRY_AFTER_MINUTES`, `MAX_CLAIM_ATTEMPTS` in `domain/oem/claims.ts`), then stays failed for a person to look at.
- The doubled quote follows OData 4.0. If GreenLake's subset rejects it, the look-up fails with the API's error, which is the right result for a serial holding a quote.
- If `find_device` is ever changed to ask for several serials in one call, the match must stay per target: pick each target's device by its own serial.
- A reviewer should check that the 2xx-but-no-match branch never reaches the PATCH, and that the three unchanged outcomes keep their messages (other code and tests compare them as text).
- Deferred: validating serials where they enter the app (ASN import, receiving), and percent-encoding the spaces and quotes of the endpoint itself. The second needs an instance (`external-contracts.md:1443`).
