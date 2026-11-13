# Plan 037: Refuse a short webhook token, and take at most 100 tracking events from one update

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- src/server/domain/shipping.ts src/server/domain/shipping.test.ts src/server/entry/shipping.ts src/server/entry/shipping.test.ts src/server/platform/shipping.ts src/server/platform/properties.ts src/fluent/delivery/logic.now.ts src/fluent/delivery/tests.now.ts src/fluent/shared/rest-api.now.ts README.md docs/spec/p3-integrations.md docs/adr/0012-one-shipping-aggregator-with-url-token-webhooks.md docs/verify-on-instance.md`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition. Line numbers that moved while the
> quoted text is the same are not a mismatch. Plans 026 and 035 each add a
> bullet to README "Upgrading", which is expected.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none. Land it after `plans/030-shipping-characterization.md` when that plan is
  to be carried out: 030 creates `src/server/platform/shipping.test.ts`, which pins how a tracking
  update is stored, and this plan then runs those tests as a check that it changed none of that.
- **Category**: security
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

The tracking webhook is the app's one route with no platform login. A shared token is all that
keeps a stranger from posting tracking updates, and two things about it are unbounded today:

- **The token's length.** Any non-empty configured token is accepted. A token of a few characters
  can be guessed, and a guessed token moves Shipments to *Delivered* and writes work notes on
  Orders.
- **The events in one update.** Every event an update lists is taken. Each one not stored yet is a
  row inserted under the Shipment's tracking lock, in a request the aggregator expects answered
  within 7 or 10 seconds. The device-events route, by contrast, caps a batch at
  `x_daas_ham.events.max_batch`.

After this plan a configured token shorter than 32 characters counts as none: every webhook is
answered as for a wrong token, and a warning names the property. And at most 100 events are taken
from one update, the newest ones, with a warning that says how many were left out.

How the webhook is authenticated (a shared token in a header, or in `?token=`) is settled by ADR
0012. This plan does not reopen it.

This changes behaviour on an upgraded instance: one whose token is shorter than 32 characters stops
accepting webhooks until an administrator sets a longer token and registers it with the aggregator.
The plan documents that in README "Upgrading".

## Current state

Files and their roles:

- `src/server/domain/shipping.ts`: the pure shipping rules. Parses a webhook, compares the token.
- `src/server/entry/shipping.ts`: `postTrackingUpdate`, the webhook's handler.
- `src/server/platform/shipping.ts`: `trackShipment`, which stores the update. Not modified.
- `src/server/platform/properties.ts`: `secretProperty`, which reads the token. Not modified.
- `src/fluent/delivery/logic.now.ts`: declares the token property. Its description changes.
- `src/fluent/delivery/tests.now.ts`: the webhook's ATF test. Not modified.
- `src/fluent/shared/rest-api.now.ts:231-241`: the route, with `authentication: false`. Not modified.

The token functions:

```ts
// src/server/domain/shipping.ts:497-512
/** The header the aggregators are registered to send the webhook token in (registered as X-NaaS-Webhook-Token; names are case-insensitive). */
export const WEBHOOK_TOKEN_HEADER = 'x-naas-webhook-token'

/** The webhook token: the header when sent (ShipEngine `headers`, EasyPost `custom_headers`), else the `?token=` fallback. */
export function webhookToken(header: unknown, query: string): string {
    const given = header === undefined || header === null ? '' : String(header)
    return given || query
}

/** Constant-time comparison of a webhook token with the configured secret (never matches an empty secret). */
export function tokenMatches(given: string, secret: string): boolean {
    if (!secret || given.length !== secret.length) return false
    let difference = 0
    for (let i = 0; i < secret.length; i++) difference |= given.charCodeAt(i) ^ secret.charCodeAt(i)
    return difference === 0
}
```

The handler:

```ts
// src/server/entry/shipping.ts:1-9
import { gs, type GlideRecord } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import { PROPERTY } from '../domain/properties.ts'
import { parseTrackingWebhook, tokenMatches, WEBHOOK_TOKEN_HEADER, webhookToken } from '../domain/shipping.ts'
import { timesRequeued } from '../platform/events.ts'
import { secretProperty } from '../platform/properties.ts'
import { str } from '../platform/records.ts'
import { queryParam, reply } from '../platform/rest-api.ts'
import { labelReturn, retryTracking, trackShipment, voidLabel } from '../platform/shipping.ts'
```

```ts
// src/server/entry/shipping.ts:29-43
/**
 * POST /shipping/tracking: tracking webhook from the aggregator (no platform login), authenticated by
 * the X-NaaS-Webhook-Token header, or by ?token= when the header is absent (ADR 0012). A Shipment or tracking event
 * the platform refuses is answered 500, not as a success, so an aggregator that retries failed deliveries
 * sends the update again. An update held off by its Shipment's tracking lock is answered 202 and applied in the
 * background, not left to the aggregator; only one that cannot be queued is
 * answered 503.
 */
export function postTrackingUpdate(request: RESTAPIRequest, response: RESTAPIResponse): void {
    const token = webhookToken(request.getHeader(WEBHOOK_TOKEN_HEADER), queryParam(request, 'token'))
    if (!tokenMatches(token, secretProperty(PROPERTY.shippingWebhookToken))) return reply(response, 401, { error: 'bad token' })
    const update = parseTrackingWebhook(request.body.data)
    if ('error' in update) return reply(response, 400, { error: update.error })
    const tracking = trackShipment(update)
    switch (tracking.outcome) {
```

The parser maps every element of the list it is sent (ShipEngine's `events`, EasyPost's
`tracking_details`):

```ts
// src/server/domain/shipping.ts:245-250
            events: asArray(field(shipEngine, 'events')).map((event) => ({
                occurredAt: text(field(event, 'occurred_at')),
                status: shipEngineStatus(field(event, 'status_code')),
                description: text(field(event, 'description')),
                location: placeName(text(field(event, 'city_locality')), text(field(event, 'country_code'))),
            })),
```

```ts
// src/server/domain/shipping.ts:267-272
            events: details.map((detail) => ({
                occurredAt: text(field(detail, 'datetime')),
                status: easyPostStatus(field(detail, 'status')),
                description: text(field(detail, 'message')),
                location: placeName(text(field(detail, 'tracking_location', 'city')), text(field(detail, 'tracking_location', 'country'))),
            })),
```

The update's shape, and how an update is placed by its newest event:

```ts
// src/server/domain/shipping.ts:181-195
export interface TrackingEvent {
    occurredAt: string
    status: ShipmentStatus
    description: string
    location: string
}

export interface TrackingUpdate {
    trackingNumber: string
    status: ShipmentStatus
    description: string
    estimatedDelivery?: string
    deliveredAt?: string
    events: TrackingEvent[]
}
```

```ts
// src/server/domain/shipping.ts:414-426
/** When the newest of `events` happened, as the carrier wrote it; '' when none is dated. */
export function newestEventAt(events: readonly { occurredAt: string }[]): string {
    let newest = ''
    let newestMs = -Infinity
    for (const event of events) {
        const ms = Date.parse(event.occurredAt)
        if (Number.isFinite(ms) && ms > newestMs) {
            newest = event.occurredAt
            newestMs = ms
        }
    }
    return newest
}
```

`trackShipment` (`src/server/platform/shipping.ts:374-379`) passes `newestEventAt(update.events)`
on, and `statusOvertaken` (`domain/shipping.ts:434-439`) uses it to decide whether the update's
status is older news than the Shipment's. Each event not stored yet is one insert, made while the
Shipment's tracking lock is held:

```ts
// src/server/platform/shipping.ts:526-541
function recordEvents(shipmentId: string, trackingNumber: string, fresh: readonly TrackingEvent[]): number {
    let refused = 0
    for (const event of fresh) {
        const record = new GlideRecord('x_daas_ham_shipment_event')
        record.initialize()
        record.setValue('shipment', shipmentId)
        record.setValue('occurred_at', event.occurredAt)
        record.setValue('status', event.status)
        record.setValue('description', event.description)
        record.setValue('location', event.location)
        if (record.insert()) continue
        refused++
        warnRefused(record, `Tracking event of ${trackingNumber} at ${event.occurredAt} not recorded`)
    }
    return refused
}
```

The property and its description:

```ts
// src/fluent/delivery/logic.now.ts:7
import { SHIPPING_MESSAGE } from '../../server/domain/shipping'
```

```ts
// src/fluent/delivery/logic.now.ts:184-191
Property({
    $id: Now.ID['prop_shipping_webhook_token'],
    name: PROPERTY.shippingWebhookToken.name,
    type: 'password2',
    value: PROPERTY.shippingWebhookToken.default,
    description: 'Shared secret the tracking webhook sends in the X-NaaS-Webhook-Token header, or as ?token= (webhooks are refused while it is empty).',
    roles: { read: [admin], write: [admin] },
})
```

`PROPERTY.shippingWebhookToken` is `{ name: 'x_daas_ham.shipping.webhook_token', default: '' }`
(`src/server/domain/properties.ts:38`). `secretProperty` (`platform/properties.ts:24-26`) returns
the stored value as it is. The log helper is `log` in `src/server/platform/log.ts`: `log.warn(text)`
writes `[x_daas_ham] <text>` as a warning.

The tests today:

```ts
// src/server/domain/shipping.test.ts:689-696
describe('tokenMatches', () => {
    it('matches only the configured, non-empty secret', () => {
        expect(tokenMatches('s3cret', 's3cret')).toBe(true)
        expect(tokenMatches('s3creT', 's3cret')).toBe(false)
        expect(tokenMatches('s3cre', 's3cret')).toBe(false)
        expect(tokenMatches('', '')).toBe(false)
    })
})
```

```ts
// src/server/entry/shipping.test.ts:14-46
const TOKEN = 'webhook-secret'

function post(token: string): { status: number; body: unknown } {
    const reply = { status: 0, body: null as unknown }
    const request = {
        body: { data: { data: { tracking_number: 'NOSUCH1', status_code: 'IT', events: [] } } },
        pathParams: {},
        queryParams: {},
        getHeader: (name: string) => (name.toLowerCase() === 'x-naas-webhook-token' ? token : undefined),
    } as unknown as RESTAPIRequest
    const response = {
        setStatus: (status: number) => void (reply.status = status),
        setBody: (body: unknown) => void (reply.body = body),
    } as unknown as RESTAPIResponse
    postTrackingUpdate(request, response)
    return reply
}

beforeEach(() => {
    platform.reset()
    platform.user = { ...platform.user, id: 'guest', roles: [] }
    platform.properties = { [PROPERTY.shippingWebhookToken.name]: TOKEN }
})

describe('the tracking webhook, called as guest', () => {
    it('takes an update sent with its token', () => {
        expect(post(TOKEN)).toEqual({ status: 200, body: { matched: false } })
    })

    it('refuses one sent with another token', () => {
        expect(post('guessed')).toEqual({ status: 401, body: { error: 'bad token' } })
    })
})
```

Both test tokens (6 and 14 characters) are shorter than the new minimum, so both tests change.

The ATF test `trackingWebhookTest` (`src/fluent/delivery/tests.now.ts:22-143`) needs no change. With
no token configured it sets one of 36 characters for its calls:

```js
// src/fluent/delivery/tests.now.ts:107-108 (inside the script step)
    var configured = gs.getProperty(NAME, '');
    var token = configured || 'atf-' + gs.generateGUID();
```

With a token configured it uses that one, so on an instance whose token is too short the test now
fails with HTTP 401. Step 5 says so in `docs/verify-on-instance.md`.

What the aggregators let you set (`docs/research/external-contracts.md:655-704`): ShipEngine takes
`headers: [{key, value}]` on a webhook, with no length limit recorded. EasyPost takes up to three
`custom_headers`, "ASCII, under 1000 characters each". A token of 32 characters fits both.

The documentation that describes this today:

```md
<!-- README.md:262-267 -->
**Shipping aggregator**: labels through the *NaaS Shipping aggregator* REST message (ShipEngine label
API, billed to `x_daas_ham.shipping.carrier_id`). Register the tracking webhook at
`https://<instance>/api/x_daas_ham/naas/shipping/tracking` with the custom header
`X-NaaS-Webhook-Token: <x_daas_ham.shipping.webhook_token>` (ShipEngine `headers`, EasyPost
`custom_headers`; `?token=` also works where the URL keeps it). ShipEngine and EasyPost tracker
payloads are accepted. Labels are not voided through the aggregator: while a return label is still
```

```md
<!-- README.md:183-185, the last bullet of "### Upgrading" -->
- Work through the checks marked **After an upgrade** in
  [docs/verify-on-instance.md](docs/verify-on-instance.md): adopting the fleet and clearing the
  earlier version's column defaults, and clean-ups of returns, fees and spare-pool purchases.
```

```md
<!-- docs/spec/p3-integrations.md:58-61 -->
- **Tracking webhook**: `POST /api/x_daas_ham/naas/shipping/tracking` (no platform login). The token
  comes in the custom header `X-NaaS-Webhook-Token` (configure it on the ShipEngine webhook's
  `headers` or EasyPost's `custom_headers`), else in `?token=`; it must equal
  `x_daas_ham.shipping.webhook_token`, and nothing is accepted while that is empty. ShipEngine
```

```md
<!-- docs/spec/p3-integrations.md:74 -->
  Unknown tracking numbers are acknowledged and ignored.
```

```md
<!-- docs/adr/0012-one-shipping-aggregator-with-url-token-webhooks.md:9-10 -->
(`?token=`) as the fallback (undocumented by both vendors). The token is compared in constant time
and everything is refused while the token property is empty. Manual tracking numbers
```

```md
<!-- docs/verify-on-instance.md:103-104 -->
(external-contracts.md N45). Where `x_daas_ham.shipping.webhook_token` was empty before the run,
confirm it is empty again after. The scripts spell out their modules' installed path, which names
```

### Conventions that apply (README.md "Development", AGENTS.md)

- `src/server/domain/` is pure: no Glide, no logging. The handler in `entry/` logs.
- A relative import in `src/server` names the `.ts` file. A `.now.ts` file imports without it.
- A `.now.ts` file holds constants, template literals over constants and imports of constants from
  `src/server/domain`. No function call, loop, spread or array element. A template literal over an
  imported number is in use already: `src/fluent/shared/rest-api.now.ts:227` writes
  `${PULL_PAGE.lines.size}` into a description.
- A test is a `*.test.ts` file beside its module. A test of `entry/` runs on
  `src/server/test-support/fake-glide.ts`: `platform.properties` holds the property values,
  `platform.logs` what was logged as `<level> <message>`, and `platform.warnings` the warnings
  without their level.
- `npm test` needs `npm run build` first: `built-metadata.test.ts` fails when a source is newer
  than `dist/app`. `npx vitest run <path>` of another file needs no build.
- `npm run build` rewrites the tracked `src/fluent/generated/keys.ts` when a Fluent record is added.
  This plan adds none, so that file must come out unchanged.
- An unused parameter is named with a leading underscore (`eslint.config.js:55`).
- ATF tests run on an instance only (`docs/verify-on-instance.md#running-atf`).

## Design decisions (already made, do not reopen)

- **Minimum token length: 32 characters**, the constant `WEBHOOK_TOKEN_MIN_LENGTH` in
  `domain/shipping.ts`. It is the length of a GUID (`gs.generateGUID()`), 128 bits when random. Both
  aggregators can send it (see above). It is a constant, not a property: an administrator should
  not be able to lower it.
- **A token that is too short counts as none.** The answer is the same HTTP 401 `bad token` as for
  a wrong token, so a caller learns nothing from it.
- **The handler logs a warning on each such refusal**, naming the property and the minimum. It
  never writes the configured token or the token sent. Nothing is logged for a wrong token against
  a usable one, or while no token is configured: that is what it does today. A module's state lasts
  one transaction on the platform, so "once" can only mean once for each refused call. The line
  appears only while the instance is misconfigured, a state in which no webhook works anyway.
- **Event cap: 100 for one update**, the constant `MAX_TRACKING_EVENTS` in `domain/shipping.ts`. A
  parcel's history is tens of scans. 100 leaves room and keeps the inserts under the lock well
  inside the aggregators' 7 and 10 seconds. It is a constant, not a property: a property is a new
  Fluent record and a README row, for a bound that protects the instance and that nobody tunes.
- **A longer list is cut, not refused.** The update's status still applies.
- **The newest events are kept**, in the order they were listed. Two reasons. An aggregator
  resends the whole history with every update, so the older events were stored from earlier
  updates and the new ones are the newest. And an update is placed by its newest event
  (`newestEventAt`, `statusOvertaken`): cut from the other end, a current update would look like
  old news and its status would be dropped. Undated events are dropped first, and of two events at
  the same time the one listed earlier, as `latestDetail` already prefers the later one listed.
- **The cut is made in the handler, after parsing**, by a pure function of `domain/shipping.ts`.
  `parseTrackingWebhook` keeps returning every event: the status detail and delivery time of an
  EasyPost update come from its latest scan, which the full list finds.
- **How the webhook is authenticated does not change** (ADR 0012).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| This plan's tests | `npx vitest run src/server/domain/shipping.test.ts src/server/entry/shipping.test.ts` | all pass (67 and 2 tests at `805d5da`) |
| Build | `npm run build` | exit 0; rewrites `dist/` |
| Built-metadata tests | `npx vitest run src/server/built-metadata.test.ts` | all pass (75 tests at `805d5da`); needs a fresh build |
| Full gate | `npm run check` | exit 0 (1804 tests at `805d5da`) |

## Scope

**In scope** (the only files you should modify):

- `src/server/domain/shipping.ts`
- `src/server/domain/shipping.test.ts`
- `src/server/entry/shipping.ts`
- `src/server/entry/shipping.test.ts`
- `src/fluent/delivery/logic.now.ts` (one import, one description)
- `README.md`
- `docs/spec/p3-integrations.md`
- `docs/adr/0012-one-shipping-aggregator-with-url-token-webhooks.md` (one sentence)
- `docs/verify-on-instance.md` (one sentence)
- `plans/README.md` (your status row only)

**Out of scope** (do NOT touch, even though they look related):

- `src/fluent/shared/rest-api.now.ts`. The route stays unauthenticated, as ADR 0012 decided.
- `src/server/platform/shipping.ts`. How an update is stored, locked and queued does not change.
- `parseTrackingWebhook` and `parseTrackingRetry`. A queued retry carries what the app itself
  queued, already cut.
- `src/server/domain/properties.ts`. No new property.
- `src/fluent/delivery/tests.now.ts`. The ATF test sets a token long enough.
- `src/fluent/generated/keys.ts`. No Fluent record is added. It must not change.
- Verifying the aggregators' own signatures (ShipEngine RSA-SHA256, EasyPost HMAC). That is a
  different decision from ADR 0012's and is not part of this finding.
- `docs/research/external-contracts.md`. It records what the vendors document, which is unchanged.

## Git workflow

- Branch: `advisor/037-tracking-webhook-bounds`, from `main`.
- One commit. Subject in the repo's style, an imperative sentence under 72 characters, for example
  `Refuse a short webhook token and cap an update's tracking events`. The body says what was wrong
  (a token of any length was accepted, and every event of an update was stored under the Shipment's
  lock) and that an instance with a token shorter than 32 characters must set a longer one.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Branch and confirm the baseline

```sh
git checkout main && git checkout -b advisor/037-tracking-webhook-bounds
npx vitest run src/server/domain/shipping.test.ts src/server/entry/shipping.test.ts
grep -rn "WEBHOOK_TOKEN_MIN_LENGTH\|webhookTokenUsable\|MAX_TRACKING_EVENTS\|boundedTracking" src README.md docs
```

**Verify**: 0 failed (67 and 2 tests at `805d5da`). Write down the two counts: the steps below call
them D (domain) and E (entry). The `grep` prints nothing.

If `src/server/platform/shipping.test.ts` exists (plan 030 created it), run it as well and confirm
0 failed: `npx vitest run src/server/platform/shipping.test.ts`. This plan must leave it passing.

### Step 2: Write the failing tests

**2a. `src/server/domain/shipping.test.ts`.**

In the import from `'./shipping'` (lines 3-24), add four names, each on its own line and in
alphabetical place: `boundedTracking,` after `applyTracking,`; `MAX_TRACKING_EVENTS,` after
`labelVoidable,`; `WEBHOOK_TOKEN_MIN_LENGTH,` after `voidedLabelOrderNote,`; and
`webhookTokenUsable,` after `webhookToken,`. The value imports then read:

```ts
    applyTracking,
    boundedTracking,
    buyLabel,
    labelVoidable,
    MAX_TRACKING_EVENTS,
    newTrackingEvents,
    newestEventAt,
    OPEN_SHIPMENTS,
    parseTrackingRetry,
    parseTrackingWebhook,
    returnLabelRefusal,
    statusOvertaken,
    tokenMatches,
    trackingEventKey,
    trackingRetryParams,
    voidedLabelOrderNote,
    WEBHOOK_TOKEN_HEADER,
    WEBHOOK_TOKEN_MIN_LENGTH,
    webhookToken,
    webhookTokenUsable,
```

Leave the `type` imports below them as they are.

Replace the whole `describe('tokenMatches', ...)` block (the last block of the file at `805d5da`,
lines 689-696) with these two blocks:

```ts
describe('tokenMatches', () => {
    const SECRET = 's3cret-'.padEnd(WEBHOOK_TOKEN_MIN_LENGTH, 'x')

    it('matches only the configured secret', () => {
        expect(tokenMatches(SECRET, SECRET)).toBe(true)
        expect(tokenMatches(`${SECRET.slice(0, -1)}X`, SECRET)).toBe(false)
        expect(tokenMatches(SECRET.slice(0, -1), SECRET)).toBe(false)
        expect(tokenMatches('', '')).toBe(false)
    })

    it('matches no token while the configured secret is shorter than the minimum, as while it is empty', () => {
        const short = SECRET.slice(0, WEBHOOK_TOKEN_MIN_LENGTH - 1)
        expect(WEBHOOK_TOKEN_MIN_LENGTH).toBe(32)
        expect(webhookTokenUsable(SECRET)).toBe(true)
        expect(webhookTokenUsable(short)).toBe(false)
        expect(webhookTokenUsable('')).toBe(false)
        expect(tokenMatches(short, short)).toBe(false)
    })
})

describe('boundedTracking', () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 6, 8, minute)).toISOString()
    const scan = (minute: number): TrackingEvent => ({ occurredAt: at(minute), status: 'in_transit', description: `Scan ${minute}`, location: '' })
    const updateOf = (events: TrackingEvent[]): TrackingUpdate => ({ trackingNumber: '1Z999', status: 'in_transit', description: 'On its way', events })

    it('leaves an update within the cap as it is', () => {
        const few = updateOf([scan(1), scan(2)])
        expect(boundedTracking(few)).toEqual({ update: few, dropped: 0 })
        const full = updateOf(Array.from({ length: MAX_TRACKING_EVENTS }, (_unused, minute) => scan(minute)))
        expect(boundedTracking(full)).toEqual({ update: full, dropped: 0 })
    })

    it('keeps the newest events of a longer one, in the order they were listed, and says how many it left out', () => {
        // Listed newest first, as an aggregator may list them: the two oldest come last.
        const listed = Array.from({ length: MAX_TRACKING_EVENTS + 2 }, (_unused, index) => scan(MAX_TRACKING_EVENTS + 1 - index))
        const bounded = boundedTracking(updateOf(listed))
        expect(bounded.dropped).toBe(2)
        expect(bounded.update.events).toEqual(listed.slice(0, MAX_TRACKING_EVENTS))
        expect(newestEventAt(bounded.update.events)).toBe(newestEventAt(listed))
        expect(bounded.update).toMatchObject({ trackingNumber: '1Z999', status: 'in_transit', description: 'On its way' })
    })

    it('leaves out undated events first, and of two at the same time the one listed earlier', () => {
        const undated: TrackingEvent = { occurredAt: '', status: 'unknown', description: 'Undated note', location: '' }
        const first = { ...scan(1), description: 'Listed first' }
        const second = { ...scan(1), description: 'Listed second' }
        const bounded = boundedTracking(updateOf([undated, first, second, scan(2)]), 2)
        expect(bounded.dropped).toBe(2)
        expect(bounded.update.events).toEqual([second, scan(2)])
    })
})
```

**2b. `src/server/entry/shipping.test.ts`.**

Add this import after the `PROPERTY` import (line 3):

```ts
import { MAX_TRACKING_EVENTS, WEBHOOK_TOKEN_MIN_LENGTH } from '../domain/shipping.ts'
```

Replace `const TOKEN = 'webhook-secret'` (line 14) with:

```ts
const TOKEN = 'webhook-secret-'.padEnd(WEBHOOK_TOKEN_MIN_LENGTH, 'x')
```

Give `post` a second parameter for the update's events. Replace its first two statements

```ts
function post(token: string): { status: number; body: unknown } {
    const reply = { status: 0, body: null as unknown }
    const request = {
        body: { data: { data: { tracking_number: 'NOSUCH1', status_code: 'IT', events: [] } } },
```

with

```ts
function post(token: string, events: object[] = []): { status: number; body: unknown } {
    const reply = { status: 0, body: null as unknown }
    const request = {
        body: { data: { data: { tracking_number: 'NOSUCH1', status_code: 'IT', events } } },
```

Add these three tests inside `describe('the tracking webhook, called as guest', ...)`, after its
last test:

```ts

    it('refuses every token while the configured one is shorter than the minimum, and warns without quoting it', () => {
        const short = TOKEN.slice(0, WEBHOOK_TOKEN_MIN_LENGTH - 1)
        platform.properties = { [PROPERTY.shippingWebhookToken.name]: short }
        expect(post(short)).toEqual({ status: 401, body: { error: 'bad token' } })
        expect(platform.warnings).toEqual([
            expect.stringContaining(`${PROPERTY.shippingWebhookToken.name} is shorter than ${WEBHOOK_TOKEN_MIN_LENGTH} characters`),
        ])
        expect(platform.logs.join('\n')).not.toContain(short)
    })

    it('logs nothing for a wrong token, or while no token is configured', () => {
        expect(post('guessed').status).toBe(401)
        platform.properties = {}
        expect(post('').status).toBe(401)
        expect(post(TOKEN).status).toBe(401)
        expect(platform.logs).toEqual([])
    })

    it('takes the newest events of an update that lists more than the cap, and warns of the rest', () => {
        const events = Array.from({ length: MAX_TRACKING_EVENTS + 5 }, (_unused, minute) => ({
            occurred_at: new Date(Date.UTC(2026, 10, 6, 8, minute)).toISOString(),
            status_code: 'IT',
            description: `Scan ${minute}`,
        }))
        expect(post(TOKEN, events)).toEqual({ status: 200, body: { matched: false } })
        expect(platform.warnings).toEqual([expect.stringContaining(`5 of its ${MAX_TRACKING_EVENTS + 5} events left out`)])
    })
```

**Verify**: `npx vitest run src/server/domain/shipping.test.ts src/server/entry/shipping.test.ts`
→ exactly 6 failed, and D + E + 1 passed (`6 failed | 70 passed` at `805d5da`). The six failures are:

- `tokenMatches > matches no token while the configured secret is shorter than the minimum, ...`
- the three tests of `boundedTracking`
- `the tracking webhook, called as guest > refuses every token while the configured one is shorter ...`
- `the tracking webhook, called as guest > takes the newest events of an update that lists more than the cap, ...`

The other new tests pass already: they hold behaviour that must stay. If the set of failures
differs, STOP.

### Step 3: Bound the token and the events in the domain

Edit `src/server/domain/shipping.ts`.

**3a.** Replace the doc comment and body of `tokenMatches` (lines 506-512) with:

```ts
/**
 * The fewest characters a configured webhook token has to be accepted. The route takes no platform login (ADR 0012),
 * so the token is all that keeps a stranger from posting tracking updates, and a short one can be guessed. 32 is the
 * length of a GUID, 128 bits when random, and both aggregators can send it: EasyPost takes a custom header value of
 * under 1000 characters, and no limit is recorded for ShipEngine's (docs/research/external-contracts.md).
 */
export const WEBHOOK_TOKEN_MIN_LENGTH = 32

/** Whether a configured secret is long enough to serve as the webhook token: one that is not counts as none. */
export function webhookTokenUsable(secret: string): boolean {
    return secret.length >= WEBHOOK_TOKEN_MIN_LENGTH
}

/** Constant-time comparison of a webhook token with the configured secret (never matches an empty or too short secret). */
export function tokenMatches(given: string, secret: string): boolean {
    if (!webhookTokenUsable(secret) || given.length !== secret.length) return false
    let difference = 0
    for (let i = 0; i < secret.length; i++) difference |= given.charCodeAt(i) ^ secret.charCodeAt(i)
    return difference === 0
}
```

**3b.** Insert directly after `newestEventAt` (it ends on line 426) and before the doc comment of
`statusOvertaken`:

```ts

/**
 * The most tracking events taken from one update. An aggregator resends a parcel's whole history with every update,
 * tens of scans; each one not stored yet is an insert made under the Shipment's tracking lock, in a request the
 * aggregator wants answered within 7 seconds (EasyPost) or 10 (ShipEngine). A longer list is cut, not refused: the
 * update's status still applies.
 */
export const MAX_TRACKING_EVENTS = 100

/**
 * `update` with at most `most` of its events, and how many were left out. The newest are kept, in the order they were
 * listed: the older ones were stored from earlier updates, and an update is placed by its newest event
 * (`newestEventAt`, `statusOvertaken`), which a cut from the other end would lose. Undated events are left out first,
 * and of two at the same time the one listed earlier.
 */
export function boundedTracking(update: TrackingUpdate, most = MAX_TRACKING_EVENTS): { update: TrackingUpdate; dropped: number } {
    const dropped = update.events.length - most
    if (dropped <= 0) return { update, dropped: 0 }
    const when = (occurredAt: string): number => {
        const ms = Date.parse(occurredAt)
        return Number.isFinite(ms) ? ms : -Infinity
    }
    const newestFirst = update.events
        .map((event, index) => ({ index, at: when(event.occurredAt) }))
        .sort((a, b) => (a.at === b.at ? b.index - a.index : b.at > a.at ? 1 : -1))
    const kept = new Set(newestFirst.slice(0, most).map(({ index }) => index))
    return { update: { ...update, events: update.events.filter((_event, index) => kept.has(index)) }, dropped }
}
```

**Verify**: `npx vitest run src/server/domain/shipping.test.ts` → 0 failed (D + 4 passed: 71 at
`805d5da`).

### Step 4: Use both bounds in the handler

Edit `src/server/entry/shipping.ts`.

Change the import of `../domain/shipping.ts` (line 4) to:

```ts
import {
    boundedTracking,
    parseTrackingWebhook,
    tokenMatches,
    WEBHOOK_TOKEN_HEADER,
    WEBHOOK_TOKEN_MIN_LENGTH,
    webhookToken,
    webhookTokenUsable,
} from '../domain/shipping.ts'
```

Add this import after the import of `../platform/events.ts`:

```ts
import { log } from '../platform/log.ts'
```

In the doc comment of `postTrackingUpdate`, add these lines before its closing `*/`:

```ts
 * A configured token shorter than domain/shipping `WEBHOOK_TOKEN_MIN_LENGTH` counts as none: every call is answered as
 * for a wrong token, and a warning names the property, never a token. Of an update that lists more events than
 * `MAX_TRACKING_EVENTS`, only the newest are taken (`boundedTracking`), with a warning.
```

Replace the first five statements of `postTrackingUpdate` (from `const token =` through
`const tracking = trackShipment(update)`) with:

```ts
    const token = webhookToken(request.getHeader(WEBHOOK_TOKEN_HEADER), queryParam(request, 'token'))
    const secret = secretProperty(PROPERTY.shippingWebhookToken)
    if (!tokenMatches(token, secret)) {
        if (secret && !webhookTokenUsable(secret)) {
            const name = PROPERTY.shippingWebhookToken.name
            log.warn(`Tracking webhook refused: ${name} is shorter than ${WEBHOOK_TOKEN_MIN_LENGTH} characters, so no token is accepted. Set a longer one and register it with the aggregator`)
        }
        return reply(response, 401, { error: 'bad token' })
    }
    const parsed = parseTrackingWebhook(request.body.data)
    if ('error' in parsed) return reply(response, 400, { error: parsed.error })
    const { update, dropped } = boundedTracking(parsed)
    if (dropped > 0) {
        log.warn(`Tracking update of ${update.trackingNumber}: ${dropped} of its ${parsed.events.length} events left out, only the newest ${update.events.length} are taken`)
    }
    const tracking = trackShipment(update)
```

The `switch (tracking.outcome)` below stays as it is.

**Verify**: `npx vitest run src/server/domain/shipping.test.ts src/server/entry/shipping.test.ts`
→ 0 failed (D + 4 and E + 3 passed: 71 and 5 at `805d5da`). If
`src/server/platform/shipping.test.ts` exists, `npx vitest run src/server/platform/shipping.test.ts`
→ 0 failed. `npm run typecheck` → exit 0.
`npm run lint` → exit 0.

### Step 5: Update the property's description and the documents

**5a. `src/fluent/delivery/logic.now.ts`.** Change line 7 to:

```ts
import { SHIPPING_MESSAGE, WEBHOOK_TOKEN_MIN_LENGTH } from '../../server/domain/shipping'
```

In the `prop_shipping_webhook_token` property (lines 184-191), replace the `description` line with
this one. Note the backticks: it is a template literal now.

```ts
    description: `Shared secret the tracking webhook sends in the X-NaaS-Webhook-Token header, or as ?token= (webhooks are refused while it is empty or shorter than ${WEBHOOK_TOKEN_MIN_LENGTH} characters).`,
```

**5b. `README.md`**, two places.

1. In the **Shipping aggregator** paragraph, after the sentence `ShipEngine and EasyPost tracker
   payloads are accepted.` (line 267) and before `Labels are not voided through the aggregator`,
   insert:

   ```md
   The token has at least 32 characters (`WEBHOOK_TOKEN_MIN_LENGTH` in
   `src/server/domain/shipping.ts`): while the property holds a shorter one, every webhook is
   answered HTTP 401 as for a wrong token, and each such call logs a warning that names the
   property, not the token. Of an update that lists more than 100 tracking events
   (`MAX_TRACKING_EVENTS`), only the newest 100 are taken, and a warning says how many were left
   out.
   ```

   Re-wrap the paragraph so that no line is much longer than its neighbours.

2. In `### Upgrading`, insert this bullet directly above the last bullet (`- Work through the
   checks marked **After an upgrade** in`):

   ```md
   - Check the length of `x_daas_ham.shipping.webhook_token`. A token shorter than 32 characters is
     no longer accepted: every tracking webhook is then answered HTTP 401, and the system log shows
     *[x_daas_ham] Tracking webhook refused: x_daas_ham.shipping.webhook_token is shorter than 32
     characters ...* (warning). Set a longer token (a random GUID will do) and register the same
     value with the aggregator's webhook ([Integrations](#integrations)).
   ```

**5c. `docs/spec/p3-integrations.md`**, two places.

1. In lines 60-61, replace

   ```md
   `x_daas_ham.shipping.webhook_token`, and nothing is accepted while that is empty. ShipEngine
   ```

   with

   ```md
   `x_daas_ham.shipping.webhook_token`, and nothing is accepted while that is empty or shorter than
   `WEBHOOK_TOKEN_MIN_LENGTH` (32 characters, `domain/shipping.ts`): a call is then answered HTTP
   401 as for a wrong token, and logs a warning that names the property and no token. ShipEngine
   ```

2. Replace line 74, `  Unknown tracking numbers are acknowledged and ignored.`, with:

   ```md
     Unknown tracking numbers are acknowledged and ignored.
     Of an update that lists more than `MAX_TRACKING_EVENTS` (100, `domain/shipping.ts`) tracking
     events, only the newest 100 are taken, in the order listed, and a warning says how many were
     left out: an aggregator resends the whole history each time, so the older ones were stored
     from earlier updates, and an update is placed by its newest event.
   ```

   Keep the two-space indent of the lines around it.

**5d. `docs/adr/0012-one-shipping-aggregator-with-url-token-webhooks.md`.** In lines 9-10, replace

```md
and everything is refused while the token property is empty. Manual tracking numbers
```

with

```md
and everything is refused while the token property is empty or holds fewer than 32 characters.
Manual tracking numbers
```

**5e. `docs/verify-on-instance.md`.** In line 104, after the sentence that ends
`confirm it is empty again after.`, insert:

```md
A configured token shorter than 32 characters fails this test with HTTP 401 on both posts: set a
longer one first (README "Upgrading").
```

**5f.** Run `npm run build`.

**Verify**:

- `npm run build` → exit 0.
- `git status --short src/fluent/generated/keys.ts` → no output (no Fluent record was added).
- `grep -l "shorter than 32 characters" dist/app/update/sys_properties_*.xml | wc -l` → `1`.
- `npx vitest run src/server/built-metadata.test.ts` → 0 failed (75 passed at `805d5da`).
- `grep -c "WEBHOOK_TOKEN_MIN_LENGTH" README.md docs/spec/p3-integrations.md` → `1` for each file.
- `grep -c "MAX_TRACKING_EVENTS" README.md docs/spec/p3-integrations.md` → `1` for each file.
- `grep -c "fewer than 32 characters" docs/adr/0012-one-shipping-aggregator-with-url-token-webhooks.md` → `1`.
- `grep -c "A configured token shorter than 32 characters fails this test" docs/verify-on-instance.md` → `1`.

### Step 6: Run the full gate and commit

```sh
npm run check
git status --short
```

**Verify**: `npm run check` exits 0. Vitest reports 0 failed and 7 more tests than before this plan
(1811 if nothing else landed since `805d5da`). `git status --short` lists only in-scope files, and
`src/fluent/generated/keys.ts` is not among them.

Commit them in one commit, with the subject from "Git workflow" and a body that says what was wrong
and why.

## Test plan

- `src/server/domain/shipping.test.ts`, modelled on the file's own `describe('newestEventAt', ...)`
  and `describe('tokenMatches', ...)`:
  - `tokenMatches`, 2 tests (1 replaced, 1 new): a token of the minimum length matches only
    itself; a secret one character short matches nothing, itself included, and
    `webhookTokenUsable` says so. This is the first regression the plan fixes.
  - `boundedTracking`, 3 new tests: an update within the cap comes back as it is; a longer one
    keeps the newest events in the listed order, reports how many it left out, and keeps the
    newest event's time; undated events go first and a tie goes to the later one listed. This is
    the second regression.
- `src/server/entry/shipping.test.ts`, modelled on its two existing tests, 3 new tests:
  - a configured token one character short refuses the call that sends it, logs one warning that
    names the property, and the log holds no token;
  - a wrong token and an unset token log nothing;
  - an update of 105 events is answered as before, and one warning says 5 of 105 were left out.
- Verification: `npx vitest run src/server/domain/shipping.test.ts src/server/entry/shipping.test.ts`
  → 0 failed (71 and 5 at `805d5da`).

What the tests cannot show. The entry tests post for a tracking number no Shipment has, so they
show the warning and the reply, not the rows stored. That a Shipment then holds at most 100 new
events follows from `trackShipment` receiving the cut update, which the domain tests pin. Whether
an instance's own token is long enough is the administrator's check in README "Upgrading".

Local and instance checks: every done criterion below is local. On an instance the existing ATF
test *NaaS - the tracking webhook needs its token and records a delivery once* (suite **NaaS -
P3**) still passes with no token configured, because it sets one of 36 characters. Say in your
report whether it was run.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm run check` exits 0, with 0 failed tests
- [ ] The test command in the test plan reports 0 failed, and the 7 new tests are among those passed
- [ ] `grep -c "export const WEBHOOK_TOKEN_MIN_LENGTH = 32\|export const MAX_TRACKING_EVENTS = 100" src/server/domain/shipping.ts` prints `2`
- [ ] `grep -n "boundedTracking(parsed)\|webhookTokenUsable(secret)" src/server/entry/shipping.ts` shows both calls
- [ ] `git diff --stat main..HEAD -- src/fluent/generated/keys.ts src/fluent/shared/rest-api.now.ts src/server/platform/shipping.ts src/fluent/delivery/tests.now.ts` prints nothing
- [ ] `grep -c "Tracking webhook refused" README.md src/server/entry/shipping.ts` prints `1` for each file (the "Upgrading" bullet quotes the log line the handler writes)
- [ ] `git status --short` is empty and only in-scope files differ from `main`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts.
- `src/server/platform/shipping.test.ts` exists and one of its tests fails after Step 3 or Step 4.
  `trackShipment` and what it stores must not change. Report the test.
- `domain/shipping.ts` already has a minimum token length or an event cap. Someone has started
  this change.
- Step 2 gives a different set of failing tests than the six listed.
- An existing test of `parseTrackingWebhook`, `newTrackingEvents` or `trackingRetryParams` fails
  after Step 3. Those functions must not change. Report the test.
- A test fails with a message that starts with `fake Glide:`. Report the message. Do not extend
  `fake-glide.ts` under this plan.
- After the build, `src/fluent/generated/keys.ts` shows as modified, or `built-metadata.test.ts`
  reports a value the SDK could not evaluate (`Symbol(` or `[object Object]`) in the property's
  description. Then put the number in the description as plain text (`shorter than 32
  characters`), drop the new import, build again, and say so in your report. If it still fails,
  stop.
- The operator says an instance in use has a webhook token shorter than 32 characters that cannot
  be changed before the upgrade. That is their call to make: the options are to rotate the token
  first, or to lower `WEBHOOK_TOKEN_MIN_LENGTH`, but only on their word.
- You are about to change `authentication: false` on the route, or to add signature checking. That
  reopens ADR 0012.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- While a token is too short, each webhook call writes one warning to the system log. An
  unauthenticated caller can add such lines only during that misconfiguration, and each call
  already costs a transaction-log row. If that ever matters, move the check to the preflight job
  (`src/server/domain/preflight.ts`) and log nothing in the handler.
- A history longer than 100 events loses its oldest events for good when none of them was stored
  before: the aggregator resends the whole history, and the cut is the same every time. The
  warning names the tracking number. Raise `MAX_TRACKING_EVENTS` if a carrier really lists more.
- `parseTrackingWebhook` still maps every event it is sent, in memory. The platform's limit on a
  REST request body bounds that. If the parser is ever given a costly step for each event, cut the
  list before parsing instead.
- A token rotation has two halves: the property and the aggregator's webhook header. Between them
  webhooks are answered 401. ShipEngine retries twice, typically 30 minutes apart, and EasyPost up
  to 6 times (`docs/research/external-contracts.md`), so do both halves together.
- Plan 026 also adds a bullet to README "Upgrading", above the same last bullet. Both bullets
  stay. Their order does not matter.
- A reviewer should check three things: the 401 body is the same for a wrong token and a short
  one, no log line can hold a token, and `keys.ts` is unchanged.
- Deferred: verifying the aggregators' signatures (ShipEngine RSA-SHA256, EasyPost HMAC), which
  would make the shared token a second factor. That is a new decision beside ADR 0012.
