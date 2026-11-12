# Plan 011: Test in-service detection and the subscription start on the fake Glide

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1864b17..HEAD -- src/server/platform/in-service.ts src/server/platform/subscriptions.ts src/server/platform/asset-identifiers.ts src/server/platform/locks.ts src/server/platform/chunked.ts src/server/domain/in-service.ts src/server/test-support/fake-glide.ts src/server/platform/in-service.test.ts src/server/platform/subscriptions.test.ts`
> The first seven paths are the code under test and the fake it runs on. The
> last two are the files you create, and must not exist yet. If any of the
> seven changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding. On a mismatch, treat it
> as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/001-lint-tracked-sources.md
- **Category**: tests
- **Planned at**: commit `1864b17`, 2026-11-12

## Why this matters

In-service detection decides when billing starts. A sighting after the install puts a pending Asset
in service, starts its Subscription line, and stamps its in-service date. No test calls
`applyDeviceEvents`, `detectPendingInService` or `attachToSubscription`, and no ATF test does
either, although `plan.md:875` lists "in-service → subscription start" as an ATF target. Only the
pure decisions (`decideInService`, `chooseSubscriptionLine`) have unit tests. A change to the
locking, the refusal handling or the identifier lookup can therefore bill a Customer from the wrong
day, or not at all, and every check stays green.

This plan adds 35 unit tests that pin what the code does today. It changes no behaviour. The tests
were written against commit `1864b17` and all pass there, so **a test that fails on the current
code is a finding to report, not a defect to fix in this plan**.

## Current state

Files and their roles:

- `src/server/platform/in-service.ts`. Applies NMS device events (`applyDeviceEvents`) and runs the detection job (`detectPendingInService`). Not changed.
- `src/server/platform/subscriptions.ts`. `attachToSubscription` links an Asset going live to its Subscription line and starts a pending line. Not changed.
- `src/server/domain/in-service.ts`. The pure decisions. Already tested in `src/server/domain/in-service.test.ts`.
- `src/server/test-support/fake-glide.ts`. The in-memory Glide the tests run on. Not changed.
- `src/server/platform/in-service.test.ts` and `src/server/platform/subscriptions.test.ts`. Do not exist. You create them.

The go-live, under the Asset's sighting lock:

```ts
// src/server/platform/in-service.ts:33-56
function goLiveIfSeen(lock: HeldLock, asset: GlideRecord, readers: LifecycleReaders): boolean {
    const stage = readStage(asset)
    const decision = decideInService({
        stage,
        installCompletedAt: glideToMs(str(asset, 'x_daas_ham_install_completed')),
        lastSeenAt: glideToMs(str(asset, 'x_daas_ham_last_seen')),
        // Only a pending Asset can go live, so only it pays for the dot-walk to its Order.
        temporary: stage === 'pending_in_service' && choice<OrderType>(asset, 'x_daas_ham_order_line.order.order_type') === 'temporary',
    })
    if (!lock.held()) return false
    // An Asset whose Subscription line could not be started stays pending, so a later sighting or run attaches it.
    if (!decision.goesLive || !attachToSubscription(asset, decision.at)) {
        if (asset.update()) return true
        log.error(`in-service detection: sighting of ${str(asset, 'serial_number')} not saved: ${refusal(asset)}`)
        return false
    }
    asset.setValue('x_daas_ham_in_service_date', msToGlide(decision.at))
    applyLifecycleDates(asset, readers)
    if (moveAndSave(asset, decision.stage, 'in-service detection')) return true
    // A line started above stays active: the sighting applied again finds it active and joins it, its start date kept.
    const pending = `${str(asset, 'serial_number')} stays pending in service, its Subscription line possibly active`
    log.error(`in-service detection: ${pending}: left to the next sighting or run`)
    return false
}
```

One event, and the batch:

```ts
// src/server/platform/in-service.ts:89-96
function applyDeviceEvent(assetId: string, event: DeviceEvent, readers: LifecycleReaders): boolean {
    return underSeenLock(assetId, (lock, asset) => {
        const stored = !isStateChange(event.event, () => lastEventKind(assetId)) || storeEvent(assetId, event)
        if (event.event === 'down') return stored
        recordSeen(asset, event.observedAt, event.source)
        return goLiveIfSeen(lock, asset, readers) && stored
    })
}

// src/server/platform/in-service.ts:103-113
export function applyDeviceEvents(events: readonly DeviceEvent[]): { unknown: string[]; busy: string[] } {
    const readers = lifecycleReaders()
    const unknown: string[] = []
    const busy: string[] = []
    for (const event of events) {
        const asset = findAssetByIdentifier(event.identifier)
        if (!asset) unknown.push(event.identifier)
        else if (!applyDeviceEvent(asset.getUniqueValue(), event, readers)) busy.push(event.identifier)
    }
    return { unknown, busy }
}
```

The line start, read afresh under the line's lock:

```ts
// src/server/platform/subscriptions.ts:69-82
function startHolding(lock: HeldLock, lineId: string, inServiceAt: number): string | TryAgain {
    const line = findById('x_daas_ham_subscription_line', lineId)
    if (!line) return 'the line is gone'
    const status = str(line, 'status')
    if (status === SUBSCRIPTION_LINE_STATUS.active) return ''
    if (status !== SUBSCRIPTION_LINE_STATUS.pending) return `the line is ${status || 'without a status'} now`
    line.setValue('status', SUBSCRIPTION_LINE_STATUS.active)
    line.setValue('start_date', toIsoDate(inServiceAt))
    // The go-live that took a lost lock over may have read the line pending too, and saved its own start date.
    const late = { check: 'check its start date', level: 'error' } as const
    const saved = lock.save(`${str(line, 'description')} started`, () => line.update(), late)
    if (saved === 'lock lost') return TRY_AGAIN
    return saved === 'refused' ? refusal(line) : ''
}
```

Conventions that apply (from `README.md` "Development", lines 308-323):

- A test is a `*.test.ts` file beside the module it tests. The build leaves it out of the app.
- A relative import in `src/server` names the `.ts` file (`'./in-service.ts'`, not `'./in-service'`).
- A platform test runs against `test-support/fake-glide.ts`. Each test file mocks Glide with this exact line, after its imports:
  `vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)`
- Model the structure on `src/server/platform/returns.test.ts`.

What the tests rely on in the fake (`src/server/test-support/fake-glide.ts`):

- `platform.reset()` clears everything. `platform.tables[table]` holds the stored rows, and a test seeds and reads them directly.
- The clock starts at 2025-11-09 12:00:00 UTC (`CLOCK_START`, line 42).
- A field that was never set to a non-blank value is absent from the stored row. That is why some assertions read `row.field ?? ''`.
- `platform.uniqueKeys = { x_daas_ham_job_lock: 'name' }` makes a second lock row with the same name be refused, which is how a job lock is held (ADR 0013). A test holds a lock by seeding its row.
- `platform.refuses(table, row, operation)` returns why a save is refused. `platform.onSave(table, row, operation)` runs just before a row is stored, and a test uses it to land "another transaction's" write at that moment.
- A dot-walk through a reference the test did not declare in `platform.references` throws an error that starts with `fake Glide:`.
- The fake runs no business rule, ACL or flow.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| One test file | `npx vitest run src/server/platform/subscriptions.test.ts` | all pass |
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 (needs plan 001; before it, use `npx eslint src`) |
| Full gate | `npm run check` | typecheck, lint, build and all tests pass |

`npm run check` runs `npm run build`, which rewrites `dist/` and may rewrite the tracked
`src/fluent/generated/keys.ts`. This plan adds no metadata, so `git status --short` must show no
change to `keys.ts` afterwards.

## Scope

**In scope** (the only files you create or modify):

- `src/server/platform/subscriptions.test.ts` (create)
- `src/server/platform/in-service.test.ts` (create)
- `plans/README.md` (your status row only)

**Out of scope** (do NOT touch):

- `src/server/platform/in-service.ts`, `src/server/platform/subscriptions.ts` and every other non-test file. This plan changes no behaviour, even where a test shows behaviour you think is wrong.
- `src/server/test-support/fake-glide.ts`. If the fake lacks something, stop.
- An ATF test for the device-events route. It is deferred (see "Maintenance notes").

## Git workflow

- Branch: `advisor/011-in-service-characterization`
- One commit. Subject in the repo's style (an imperative sentence under 72 characters), for example:
  `Test in-service detection and the subscription start`
  The body says that no test called `applyDeviceEvents`, `detectPendingInService` or `attachToSubscription`, and that the tests pin the behaviour as it is at `1864b17`.
- Do NOT push or open a PR unless the operator told you to.

## Steps

### Step 1: Record the baseline

Run the existing platform tests and note the totals.

**Verify**: `npx vitest run src/server/platform` → all pass. `ls src/server/platform/in-service.test.ts src/server/platform/subscriptions.test.ts` → both "No such file".

### Step 2: Create the subscription tests

Create `src/server/platform/subscriptions.test.ts` with exactly this content:

```ts
import type { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCK } from '../domain/lock-names.ts'
import { attachToSubscription } from './subscriptions.ts'
import { platform, recordOf, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const ASSETS = 'alm_hardware'
const LINES = 'x_daas_ham_subscription_line'
const LOCKS = 'x_daas_ham_job_lock'

const LIVE_AT = Date.parse('2025-11-09T09:00:00Z')

const lineRow = (id = 'sub1'): Row => (platform.tables[LINES] ?? []).find((row) => row.sys_id === id) ?? {}

function subscriptionLine(fields: Row = {}): Row {
    return { sys_id: 'sub1', agreement: 'ag1', line_type: 'device_class', device_class: 'switch', site: '', status: 'pending', start_date: '', end_date: '', description: 'Switches', ...fields }
}

function goingLive(): GlideRecord {
    return recordOf<GlideRecord>(ASSETS, { sys_id: 'a1', serial_number: 'FOC111', x_daas_ham_agreement: 'ag1', x_daas_ham_site: 'site1', model: 'm1' })
}

beforeEach(() => {
    platform.reset()
    platform.uniqueKeys = { [LOCKS]: 'name' }
    platform.references = { [`${ASSETS}.model`]: 'cmdb_model' }
    platform.tables.cmdb_model = [{ sys_id: 'm1', x_daas_ham_device_class: 'switch' }]
    platform.tables[LINES] = [subscriptionLine()]
})

describe('attaching an Asset going into service to its Subscription line', () => {
    it('starts a pending line from the day it went into service and links the Asset to it', () => {
        const asset = goingLive()

        expect(attachToSubscription(asset, LIVE_AT)).toBe(true)

        expect(asset.getValue('x_daas_ham_subscription_line')).toBe('sub1')
        expect(lineRow()).toMatchObject({ status: 'active', start_date: '2025-11-09' })
        expect(platform.tables[LOCKS]).toEqual([])
        expect(platform.logs).toEqual([])
    })

    it('joins an active line and keeps its start date', () => {
        platform.tables[LINES] = [subscriptionLine({ status: 'active', start_date: '2025-10-01' })]
        const asset = goingLive()

        expect(attachToSubscription(asset, LIVE_AT)).toBe(true)

        expect(asset.getValue('x_daas_ham_subscription_line')).toBe('sub1')
        expect(lineRow()).toMatchObject({ status: 'active', start_date: '2025-10-01' })
    })

    it('links the Asset to no line, and lets it go live, when none matches', () => {
        platform.tables[LINES] = [
            subscriptionLine({ sys_id: 'ended', status: 'ended' }),
            subscriptionLine({ sys_id: 'other-agreement', agreement: 'ag2' }),
            subscriptionLine({ sys_id: 'other-class', device_class: 'firewall' }),
            subscriptionLine({ sys_id: 'other-site', site: 'site2' }),
        ]
        const before = platform.tables[LINES].map((row) => ({ ...row }))
        const asset = goingLive()

        expect(attachToSubscription(asset, LIVE_AT)).toBe(true)

        expect(asset.getValue('x_daas_ham_subscription_line')).toBeNull()
        expect(platform.tables[LINES]).toEqual(before)
    })

    it("chooses the Site's package over a device-class line", () => {
        platform.tables[LINES] = [subscriptionLine(), subscriptionLine({ sys_id: 'pkg', line_type: 'site_package', device_class: '', site: 'site1' })]
        const asset = goingLive()

        attachToSubscription(asset, LIVE_AT)

        expect(asset.getValue('x_daas_ham_subscription_line')).toBe('pkg')
        expect(lineRow('pkg').status).toBe('active')
        expect(lineRow('sub1').status).toBe('pending')
    })
})

describe('a pending line that cannot be started', () => {
    it('keeps the Asset off it when the platform refuses the save', () => {
        platform.refuses = (table, _row, operation) => (table === LINES && operation === 'update' ? 'line locked by finance' : '')
        const asset = goingLive()

        expect(attachToSubscription(asset, LIVE_AT)).toBe(false)

        expect(asset.getValue('x_daas_ham_subscription_line')).toBeNull()
        expect(lineRow().status).toBe('pending')
        expect(platform.warnings).toEqual([expect.stringContaining('FOC111 stays pending in service, line not started: line locked by finance')])
        expect(platform.tables[LOCKS]).toEqual([])
    })

    it('keeps the Asset off it when another go-live holds its lock through every try', () => {
        platform.tables[LOCKS] = [{ sys_id: 'lock1', name: LOCK.subscriptionLine('sub1'), sys_created_on: '2025-11-09 12:00:00' }]
        const asset = goingLive()

        expect(attachToSubscription(asset, LIVE_AT)).toBe(false)

        expect(lineRow().status).toBe('pending')
        expect(platform.warnings).toEqual([expect.stringContaining('line not started: another go-live held its lock through every try')])
    })
})

describe('a pending line changed between the read and its lock', () => {
    /** Another transaction's write lands as this go-live takes the line's lock. */
    function asTheLockIsTaken(change: () => void): void {
        platform.onSave = (table, _row, operation) => {
            if (table === LOCKS && operation === 'insert') change()
        }
    }

    it('is joined with its start date kept when another go-live started it', () => {
        asTheLockIsTaken(() => Object.assign(lineRow(), { status: 'active', start_date: '2025-11-07' }))
        const asset = goingLive()

        expect(attachToSubscription(asset, LIVE_AT)).toBe(true)

        expect(asset.getValue('x_daas_ham_subscription_line')).toBe('sub1')
        expect(lineRow()).toMatchObject({ status: 'active', start_date: '2025-11-07' })
    })

    it('is not started again once ended by hand', () => {
        asTheLockIsTaken(() => Object.assign(lineRow(), { status: 'ended', end_date: '2025-11-08' }))
        const asset = goingLive()

        expect(attachToSubscription(asset, LIVE_AT)).toBe(false)

        expect(lineRow()).toMatchObject({ status: 'ended', start_date: '' })
        expect(platform.warnings).toEqual([expect.stringContaining('line not started: the line is ended now')])
    })

    it('keeps the Asset pending once it is gone', () => {
        asTheLockIsTaken(() => (platform.tables[LINES] = []))
        const asset = goingLive()

        expect(attachToSubscription(asset, LIVE_AT)).toBe(false)

        expect(platform.warnings).toEqual([expect.stringContaining('line not started: the line is gone')])
    })
})
```

**Verify**: `npx vitest run src/server/platform/subscriptions.test.ts` → `Tests  9 passed (9)`.

### Step 3: Create the in-service tests

Create `src/server/platform/in-service.test.ts` with exactly this content:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JOB } from '../domain/chunked-job.ts'
import type { DeviceEvent } from '../domain/device-events.ts'
import { fieldsOf, type Stage } from '../domain/lifecycle.ts'
import { LOCK } from '../domain/lock-names.ts'
import { applyDeviceEvents, detectPendingInService } from './in-service.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)


const ASSETS = 'alm_hardware'
const LINES = 'x_daas_ham_subscription_line'
const EVENTS = 'x_daas_ham_device_event'
const LOCKS = 'x_daas_ham_job_lock'
const CURSORS = 'x_daas_ham_job_cursor'

const INSTALLED = '2025-11-08 10:00:00'
const SEEN = '2025-11-09 09:00:00'
const SEEN_MS = Date.parse('2025-11-09T09:00:00Z')

const rows = (table: string): Row[] => platform.tables[table] ?? []
const asset = (id = 'a1'): Row => rows(ASSETS).find((row) => row.sys_id === id) ?? {}
const line = (): Row => rows(LINES)[0] ?? {}

function stage(of: Stage): Row {
    const { installStatus, substatus } = fieldsOf(of)
    return { install_status: installStatus, substatus: substatus ?? '' }
}

function unit(of: Stage, fields: Row = {}): Row {
    return {
        sys_id: 'a1',
        serial_number: 'FOC111',
        x_daas_ham_fleet: 'true',
        x_daas_ham_site: 'site1',
        x_daas_ham_agreement: 'ag1',
        x_daas_ham_order_line: 'ol1',
        x_daas_ham_install_completed: INSTALLED,
        model: 'm1',
        ...stage(of),
        ...fields,
    }
}

function event(fields: Partial<DeviceEvent> = {}): DeviceEvent {
    return { identifier: 'FOC111', event: 'seen', observedAt: SEEN_MS, source: 'nms', ...fields }
}

beforeEach(() => {
    platform.reset()
    platform.uniqueKeys = { [LOCKS]: 'name', [CURSORS]: 'job' }
    platform.references = {
        [`${ASSETS}.x_daas_ham_order_line`]: 'x_daas_ham_order_line',
        'x_daas_ham_order_line.order': 'x_daas_ham_order',
        [`${ASSETS}.model`]: 'cmdb_model',
        [`${ASSETS}.ci`]: 'cmdb_ci',
    }
    platform.tables.cmdb_model = [{ sys_id: 'm1', x_daas_ham_device_class: 'switch' }]
    platform.tables.x_daas_ham_order = [{ sys_id: 'o1', order_type: 'site_rollout' }]
    platform.tables.x_daas_ham_order_line = [{ sys_id: 'ol1', order: 'o1' }]
    platform.tables.x_daas_ham_agreement = [{ sys_id: 'ag1', refresh_basis: 'cycle', refresh_cycle_months: '36' }]
    platform.tables[LINES] = [{ sys_id: 'sub1', agreement: 'ag1', line_type: 'device_class', device_class: 'switch', site: '', status: 'pending', start_date: '', description: 'Switches' }]
    platform.tables[ASSETS] = [unit('pending_in_service')]
})

describe('a seen event for a pending Asset', () => {
    it('puts it in service from the sighting and starts its pending line', () => {
        expect(applyDeviceEvents([event()])).toEqual({ unknown: [], busy: [] })

        expect(asset()).toMatchObject({
            ...stage('in_service'),
            x_daas_ham_last_seen: SEEN,
            x_daas_ham_seen_source: 'nms',
            x_daas_ham_in_service_date: SEEN,
            x_daas_ham_subscription_line: 'sub1',
            x_daas_ham_lifecycle_phase: 'available',
            x_daas_ham_refresh_due: '2028-11-09',
        })
        expect(line()).toMatchObject({ status: 'active', start_date: '2025-11-09' })
        expect(rows(EVENTS)).toEqual([expect.objectContaining({ asset: 'a1', identifier: 'FOC111', event: 'seen', source: 'nms', observed_at: SEEN })])
        expect(rows(LOCKS)).toEqual([])
        expect(platform.logs).toEqual([])
    })

    it('joins a line that is already active and keeps its start date', () => {
        Object.assign(line(), { status: 'active', start_date: '2025-10-01' })

        applyDeviceEvents([event()])

        expect(asset()).toMatchObject({ ...stage('in_service'), x_daas_ham_subscription_line: 'sub1' })
        expect(line()).toMatchObject({ status: 'active', start_date: '2025-10-01' })
    })

    it('goes into service on no line when none matches', () => {
        platform.tables[LINES] = []

        applyDeviceEvents([event()])

        expect(asset()).toMatchObject({ ...stage('in_service'), x_daas_ham_in_service_date: SEEN })
        expect(asset().x_daas_ham_subscription_line ?? '').toBe('')
    })

    it('becomes a temporary deployment on a temporary Order', () => {
        platform.tables.x_daas_ham_order = [{ sys_id: 'o1', order_type: 'temporary' }]

        applyDeviceEvents([event()])

        expect(asset()).toMatchObject(stage('temporary_deployment'))
    })

    it('stays pending when it was seen before its install was completed', () => {
        const early = Date.parse('2025-11-08T09:00:00Z')

        expect(applyDeviceEvents([event({ observedAt: early })])).toEqual({ unknown: [], busy: [] })

        expect(asset()).toMatchObject({ ...stage('pending_in_service'), x_daas_ham_last_seen: '2025-11-08 09:00:00' })
        expect(asset().x_daas_ham_in_service_date ?? '').toBe('')
        expect(line().status).toBe('pending')
        expect(rows(EVENTS)).toHaveLength(1)
    })

    it('stays pending, the sighting saved, when its line cannot be started, and goes live when the event is sent again', () => {
        platform.refuses = (table, _row, operation) => (table === LINES && operation === 'update' ? 'line locked by finance' : '')

        expect(applyDeviceEvents([event()])).toEqual({ unknown: [], busy: [] })

        expect(asset()).toMatchObject({ ...stage('pending_in_service'), x_daas_ham_last_seen: SEEN })
        expect(asset().x_daas_ham_subscription_line ?? '').toBe('')
        expect(line().status).toBe('pending')
        expect(platform.warnings).toEqual([expect.stringContaining('FOC111 stays pending in service, line not started: line locked by finance')])

        platform.refuses = () => ''
        applyDeviceEvents([event()])

        expect(asset()).toMatchObject({ ...stage('in_service'), x_daas_ham_in_service_date: SEEN, x_daas_ham_subscription_line: 'sub1' })
        expect(line()).toMatchObject({ status: 'active', start_date: '2025-11-09' })
    })

    it('is reported busy when its go-live save is refused, its line left active, and joins that line when sent again', () => {
        platform.refuses = (table, _row, operation) => (table === ASSETS && operation === 'update' ? 'stage rule said no' : '')

        expect(applyDeviceEvents([event()])).toEqual({ unknown: [], busy: ['FOC111'] })

        expect(asset()).toMatchObject(stage('pending_in_service'))
        expect(asset().x_daas_ham_last_seen ?? '').toBe('')
        expect(line()).toMatchObject({ status: 'active', start_date: '2025-11-09' })
        expect(platform.logs).toEqual([
            expect.stringMatching(/^warn .*in-service detection: FOC111 not moved to in_service: stage rule said no/),
            expect.stringMatching(/^error .*FOC111 stays pending in service, its Subscription line possibly active/),
        ])

        platform.refuses = () => ''
        const later = SEEN_MS + 86_400_000
        expect(applyDeviceEvents([event({ observedAt: later })])).toEqual({ unknown: [], busy: [] })

        expect(asset()).toMatchObject({ ...stage('in_service'), x_daas_ham_in_service_date: '2025-11-10 09:00:00', x_daas_ham_subscription_line: 'sub1' })
        expect(line()).toMatchObject({ status: 'active', start_date: '2025-11-09' })
    })
})

describe('a sighting of an Asset already in service', () => {
    beforeEach(() => {
        platform.tables[ASSETS] = [unit('in_service', { x_daas_ham_last_seen: SEEN, x_daas_ham_seen_source: 'discovery', x_daas_ham_in_service_date: SEEN, x_daas_ham_subscription_line: 'sub1' })]
        Object.assign(line(), { status: 'active', start_date: '2025-11-09' })
    })

    it('moves last seen forward and changes nothing else', () => {
        applyDeviceEvents([event({ observedAt: SEEN_MS + 3_600_000 })])

        expect(asset()).toMatchObject({ ...stage('in_service'), x_daas_ham_last_seen: '2025-11-09 10:00:00', x_daas_ham_seen_source: 'nms', x_daas_ham_in_service_date: SEEN })
        expect(line().start_date).toBe('2025-11-09')
    })

    it('does not move last seen back for an older sighting', () => {
        expect(applyDeviceEvents([event({ observedAt: SEEN_MS - 3_600_000 })])).toEqual({ unknown: [], busy: [] })

        expect(asset()).toMatchObject({ x_daas_ham_last_seen: SEEN, x_daas_ham_seen_source: 'discovery' })
    })
})

describe('the device events stored', () => {
    it('are the state changes only: a sighting after a stored sighting adds none', () => {
        const at = (hours: number) => SEEN_MS + hours * 3_600_000

        applyDeviceEvents([event(), event({ observedAt: at(1) }), event({ event: 'down', observedAt: at(2) }), event({ observedAt: at(3) })])

        expect(rows(EVENTS).map((row) => [row.event, row.observed_at])).toEqual([
            ['seen', '2025-11-09 09:00:00'],
            ['down', '2025-11-09 11:00:00'],
            ['seen', '2025-11-09 12:00:00'],
        ])
        expect(asset().x_daas_ham_last_seen).toBe('2025-11-09 12:00:00')
    })

    it('include a down event, which changes nothing on the Asset', () => {
        const before = { ...asset() }

        expect(applyDeviceEvents([event({ event: 'down' })])).toEqual({ unknown: [], busy: [] })

        expect(rows(EVENTS)).toEqual([expect.objectContaining({ asset: 'a1', event: 'down', observed_at: SEEN })])
        expect(asset()).toEqual(before)
        expect(line().status).toBe('pending')
    })

    it('report a down event the platform refuses to store as busy', () => {
        platform.refuses = (table) => (table === EVENTS ? 'no room' : '')

        expect(applyDeviceEvents([event({ event: 'down' })])).toEqual({ unknown: [], busy: ['FOC111'] })

        expect(rows(EVENTS)).toEqual([])
        expect(platform.logs).toEqual([expect.stringMatching(/^error .*down event of FOC111 not stored: no room/)])
    })

    it('report a sighting the platform refuses to store as busy, the Asset put in service all the same', () => {
        platform.refuses = (table) => (table === EVENTS ? 'no room' : '')

        expect(applyDeviceEvents([event()])).toEqual({ unknown: [], busy: ['FOC111'] })

        expect(asset()).toMatchObject(stage('in_service'))
    })
})

describe('the identifier of an event', () => {
    it('names a fleet asset by its Provider tag, however it is typed', () => {
        platform.tables[ASSETS] = [unit('pending_in_service', { asset_tag: 'NAAS0000001' })]

        expect(applyDeviceEvents([event({ identifier: ' naas0000001 ' })])).toEqual({ unknown: [], busy: [] })

        expect(asset()).toMatchObject(stage('in_service'))
        expect(rows(EVENTS)[0]?.identifier).toBe(' naas0000001 ')
    })

    it('is unknown when no fleet asset carries it, and stores no event', () => {
        expect(applyDeviceEvents([event({ identifier: 'NOPE' })])).toEqual({ unknown: ['NOPE'], busy: [] })

        expect(rows(EVENTS)).toEqual([])
        expect(asset()).toMatchObject(stage('pending_in_service'))
    })

    it("is unknown when only one of the Provider IT's assets carries it", () => {
        platform.tables[ASSETS] = [unit('pending_in_service', { x_daas_ham_fleet: '' })]

        expect(applyDeviceEvents([event()])).toEqual({ unknown: ['FOC111'], busy: [] })

        expect(asset()).toMatchObject(stage('pending_in_service'))
    })

    it('is unknown, with a warning, when two fleet assets carry it as their Customer tag', () => {
        platform.tables[ASSETS] = [
            unit('pending_in_service', { x_daas_ham_customer_tag: 'SW-01' }),
            unit('pending_in_service', { sys_id: 'a2', serial_number: 'FOC222', x_daas_ham_customer_tag: 'SW-01' }),
        ]

        expect(applyDeviceEvents([event({ identifier: 'SW-01' })])).toEqual({ unknown: ['SW-01'], busy: [] })

        expect(platform.warnings).toEqual([expect.stringContaining('Identifier SW-01 refused: More than one asset has Customer tag SW-01')])
        expect(asset('a1')).toMatchObject(stage('pending_in_service'))
        expect(asset('a2')).toMatchObject(stage('pending_in_service'))
        expect(rows(EVENTS)).toEqual([])
    })
})

describe("an Asset's sighting lock", () => {
    it('held by another sighting through every try leaves the event busy and unapplied', () => {
        platform.tables[LOCKS] = [{ sys_id: 'lock1', name: LOCK.seenAsset('a1'), sys_created_on: '2025-11-09 12:00:00' }]

        expect(applyDeviceEvents([event()])).toEqual({ unknown: [], busy: ['FOC111'] })

        expect(asset()).toMatchObject(stage('pending_in_service'))
        expect(asset().x_daas_ham_last_seen ?? '').toBe('')
        expect(rows(EVENTS)).toEqual([])
        expect(line().status).toBe('pending')
    })

    it('lost before the Asset is saved leaves the event busy, the Asset and its line untouched', () => {
        // Another sighting takes the lock over as abandoned while this one stores its event.
        platform.onSave = (table) => {
            if (table === EVENTS) platform.tables[LOCKS] = []
        }

        expect(applyDeviceEvents([event()])).toEqual({ unknown: [], busy: ['FOC111'] })

        expect(asset()).toMatchObject(stage('pending_in_service'))
        expect(asset().x_daas_ham_last_seen ?? '').toBe('')
        expect(line().status).toBe('pending')
        expect(rows(EVENTS)).toHaveLength(1)
    })
})

describe('a sighting that does not put the Asset in service', () => {
    it('is reported busy, and logged, when the platform refuses to save it', () => {
        platform.tables[ASSETS] = [unit('in_service', { x_daas_ham_last_seen: SEEN })]
        platform.refuses = (table, _row, operation) => (table === ASSETS && operation === 'update' ? 'read only' : '')

        expect(applyDeviceEvents([event({ observedAt: SEEN_MS + 3_600_000 })])).toEqual({ unknown: [], busy: ['FOC111'] })

        expect(asset().x_daas_ham_last_seen).toBe(SEEN)
        expect(platform.logs).toEqual([expect.stringMatching(/^error .*in-service detection: sighting of FOC111 not saved: read only/)])
    })
})

describe('the in-service detection job', () => {
    const discovered = (fields: Row = {}): Row => ({ sys_id: 'ci1', last_discovered: SEEN, discovery_source: 'ServiceNow', ...fields })

    beforeEach(() => {
        platform.tables[ASSETS] = [unit('pending_in_service', { ci: 'ci1' })]
        platform.tables.cmdb_ci = [discovered()]
    })

    it('puts a pending Asset in service from what Discovery last saw of its CI', () => {
        detectPendingInService()

        expect(asset()).toMatchObject({
            ...stage('in_service'),
            x_daas_ham_last_seen: SEEN,
            x_daas_ham_seen_source: 'discovery',
            x_daas_ham_in_service_date: SEEN,
            x_daas_ham_subscription_line: 'sub1',
        })
        expect(line()).toMatchObject({ status: 'active', start_date: '2025-11-09' })
        expect(rows(EVENTS)).toEqual([])
        expect(rows(LOCKS)).toEqual([])
        expect(rows(CURSORS)).toEqual([expect.objectContaining({ job: JOB.inServiceDetection, last_status: 'complete', processed_total: '1', failed_total: '0' })])
    })

    it('reads any other discovery source as a connector', () => {
        platform.tables.cmdb_ci = [discovered({ discovery_source: 'SG-Meraki' })]

        detectPendingInService()

        expect(asset()).toMatchObject({ ...stage('in_service'), x_daas_ham_seen_source: 'connector' })
    })

    it('leaves an Asset pending whose CI was last discovered before its install was completed', () => {
        platform.tables.cmdb_ci = [discovered({ last_discovered: '2025-11-08 09:00:00' })]

        detectPendingInService()

        expect(asset()).toMatchObject({ ...stage('pending_in_service'), x_daas_ham_last_seen: '2025-11-08 09:00:00', x_daas_ham_seen_source: 'discovery' })
        expect(line().status).toBe('pending')
    })

    it('leaves an Asset pending whose CI was never discovered, or that has no CI', () => {
        platform.tables.cmdb_ci = [discovered({ last_discovered: '' })]
        platform.tables[ASSETS].push(unit('pending_in_service', { sys_id: 'a2', serial_number: 'FOC222', ci: '' }))
        const before = [{ ...asset('a1') }, { ...asset('a2') }]

        detectPendingInService()

        expect([asset('a1'), asset('a2')]).toEqual(before)
    })

    it("visits pending fleet assets only: not one in another stage, nor the Provider IT's", () => {
        platform.tables[ASSETS] = [
            unit('shipped', { ci: 'ci1' }),
            unit('pending_in_service', { sys_id: 'a2', serial_number: 'FOC222', ci: 'ci1', x_daas_ham_fleet: '' }),
        ]
        const before = [{ ...asset('a1') }, { ...asset('a2') }]

        detectPendingInService()

        expect([asset('a1'), asset('a2')]).toEqual(before)
        expect(rows(CURSORS)[0]).toMatchObject({ processed_total: '0', last_status: 'complete' })
    })

    it('leaves an Asset whose sighting lock an NMS event holds to the next run, without failing', () => {
        platform.tables[LOCKS] = [{ sys_id: 'lock1', name: LOCK.seenAsset('a1'), sys_created_on: '2025-11-09 12:00:00' }]

        detectPendingInService()

        expect(asset()).toMatchObject(stage('pending_in_service'))
        expect(rows(CURSORS)[0]).toMatchObject({ failed_total: '0', last_status: 'complete' })
    })
})
```

**Verify**: `npx vitest run src/server/platform/in-service.test.ts` → `Tests  26 passed (26)`.

### Step 4: Run the gate and commit

**Verify**:

- `npm run typecheck` → exit 0.
- `npm run lint` → exit 0.
- `npm run check` → exit 0, and the test total is 35 higher than before this plan (1621 if nothing else landed since `1864b17`, where it was 1586).
- `git status --short` → only the two new test files (and `plans/README.md` once you update it).

Then commit the two files.

## Test plan

Every test is in the two blocks above. The tables say what each one sets up beyond its file's shared
fixture and what it asserts, so that a failure can be reported by behaviour.

`subscriptions.test.ts` calls `attachToSubscription(asset, 2025-11-09T09:00Z)` directly. Shared
fixture: one pending device-class line `sub1` (class switch, no Site) on Agreement `ag1`, and an
unsaved Asset `a1` of Model `m1` (class switch) at `site1` under `ag1`.

| Test | Setup | Asserts |
|---|---|---|
| starts a pending line | none | returns true, Asset linked to `sub1`, line active from 2025-11-09, no lock row left, nothing logged |
| joins an active line | line active since 2025-10-01 | returns true, Asset linked, start date still 2025-10-01 |
| links to no line when none matches | four lines: ended, other Agreement, other class, other Site | returns true, Asset linked to none, lines unchanged |
| Site package wins | `sub1` plus a site package for `site1` | Asset linked to the package, package active, `sub1` still pending |
| save refused | the platform refuses the line update | returns false, Asset not linked, line pending, one warning with the reason, no lock row left |
| lock held through every try | a lock row named `LOCK.subscriptionLine('sub1')` | returns false, line pending, warning "another go-live held its lock through every try" |
| started by another go-live meanwhile | line set active from 2025-11-07 as the lock is taken | returns true, Asset linked, start date 2025-11-07 kept |
| ended by hand meanwhile | line set ended as the lock is taken | returns false, line stays ended with no start date, warning "the line is ended now" |
| gone meanwhile | line deleted as the lock is taken | returns false, warning "the line is gone" |

`in-service.test.ts` calls `applyDeviceEvents` and `detectPendingInService`. Shared fixture: fleet
Asset `a1` (serial FOC111) pending in service at `site1` under `ag1`, install completed 2025-11-08
10:00, on Order line `ol1` of a site-rollout Order, Model `m1` (class switch). Agreement `ag1` has a
36-month refresh cycle. Line `sub1` is pending. The default event is `seen` for `FOC111` at
2025-11-09 09:00 from source `nms`.

| Test | Setup | Asserts |
|---|---|---|
| seen event puts it in service | none | no unknown, no busy. Asset in service, last seen and in-service date 2025-11-09 09:00, source nms, linked to `sub1`, phase available, refresh due 2028-11-09. Line active from 2025-11-09. One `seen` device event. No lock row, nothing logged |
| joins an active line | line active since 2025-10-01 | Asset in service on `sub1`, start date kept |
| no line matches | no line | Asset in service with its in-service date, linked to no line |
| temporary Order | Order type temporary | Asset in temporary deployment |
| seen before the install | event at 2025-11-08 09:00 | not busy. Asset pending with last seen saved, no in-service date, line pending, event stored |
| line cannot be started | line update refused | not busy. Asset pending with last seen saved, not linked, one warning. Refusal lifted and the same event sent again: in service from 2025-11-09 09:00, line active from 2025-11-09 |
| go-live save refused | Asset update refused | busy `FOC111`. Asset pending, last seen not saved, line active from 2025-11-09, one warning then one error. Refusal lifted and a sighting one day later sent: in service from 2025-11-10 09:00, line start still 2025-11-09 |
| later sighting, Asset in service | Asset in service, seen 09:00 by discovery | last seen 10:00, source nms, in-service date and line start unchanged |
| older sighting, Asset in service | same, event at 08:00 | last seen and source unchanged |
| only state changes stored | events seen, seen, down, seen | three device events (seen 09:00, down 11:00, seen 12:00), last seen 12:00 |
| down event | event `down` | not busy, one `down` event stored, Asset row unchanged, line pending |
| down event refused | device event insert refused | busy `FOC111`, no event stored, one error |
| sighting event refused | device event insert refused | busy `FOC111`, Asset in service all the same |
| Provider tag, any typing | Asset tag `NAAS0000001`, identifier `' naas0000001 '` | Asset in service, the event keeps the identifier as sent |
| unknown identifier | identifier `NOPE` | unknown `NOPE`, no event, Asset pending |
| Provider IT's asset | Asset's Fleet flag blank | unknown `FOC111`, Asset pending |
| ambiguous Customer tag | two fleet Assets tagged `SW-01` | unknown `SW-01`, one warning, both pending, no event |
| sighting lock held | lock row `LOCK.seenAsset('a1')` | busy `FOC111`, Asset and line untouched, no event |
| sighting lock lost | lock row removed as the event is stored | busy `FOC111`, Asset and line untouched, the event stored |
| sighting save refused | Asset in service, update refused | busy `FOC111`, last seen unchanged, one error |
| job: Discovery sighting | Asset's CI discovered 2025-11-09 09:00 by `ServiceNow` | Asset in service, source discovery, linked, line active, no device event, no lock row, job cursor complete with 1 processed and 0 failed |
| job: other discovery source | source `SG-Meraki` | source connector |
| job: discovered before install | CI discovered 2025-11-08 09:00 | Asset pending with last seen saved, line pending |
| job: never discovered, or no CI | CI without a date, and a second Asset without a CI | both Asset rows unchanged |
| job: pending fleet assets only | a shipped fleet Asset and a pending Asset outside the fleet | both unchanged, cursor complete with 0 processed |
| job: sighting lock held | lock row `LOCK.seenAsset('a1')` | Asset pending, cursor complete with 0 failed |

Structural pattern: `src/server/platform/returns.test.ts`.

## Done criteria

All local. No instance is needed. ALL must hold:

- [ ] `npx vitest run src/server/platform/subscriptions.test.ts` → 9 passed
- [ ] `npx vitest run src/server/platform/in-service.test.ts` → 26 passed
- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm run check` exits 0
- [ ] `git show --stat --format= HEAD` lists the two test files and no other file (`plans/README.md` aside)
- [ ] `git status --short` shows no file outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- **A new test fails.** First compare your file with the block in this plan and copy it again if it differs. If it still fails, stop. Report the test's full name, and the expected and received values that vitest prints. Do not change the code under test, do not edit the assertion, do not skip the test, and do not commit. The tests passed at `1864b17`, so a failure means the behaviour changed since, and the owner must decide which is right.
- A test throws an error that starts with `fake Glide:`. The fake does not model something the code now does. Changing `test-support/` is out of scope.
- The drift check shows a change in a file under test and the excerpts in "Current state" no longer match.
- `npm run typecheck` or `npm run lint` reports an error in one of the two new files after you copied it again from this plan.
- `npm run check` changes `src/fluent/generated/keys.ts`. This plan adds no metadata, so that change comes from somewhere else.
- A test file with either name already exists.

## Maintenance notes

- These are characterization tests. When in-service behaviour changes on purpose, change the matching test in the same commit and say so in the commit body.
- Several tests assert a fragment of a log line (for example `stays pending in service, line not started`). An administrator reads those lines. If the wording changes, update the fragment.
- Not covered, and why:
  - The branch of `startHolding` that returns `TRY_AGAIN` when the line's lock is lost between the take and the save. The fake has no hook on a read, so a test cannot remove the lock at that moment.
  - Real concurrency. The fake runs one transaction at a time. Two sightings at once are a check on an instance (`docs/verify-on-instance.md`, the job-lock sections).
  - `purgeDeviceEventsOlderThan` and `endSitePackageIfEmpty`.
  - The chunking of the detection job (pause on the time budget, resume from the cursor). `src/server/platform/chunked.test.ts` covers the runner.
- Deferred: the ATF test "in-service → subscription start" that `plan.md:875` lists. It needs an instance to mean anything, and a user with the integration role to post events. Plan 012 shows how an ATF test calls a route handler from a server-side script, and is the pattern to follow.
- At planning time each of these changes to the code made at least one of these tests fail: letting last seen move back, dropping the lock-lost check, recording a `down` event as a sighting, going live when the line start is refused, letting the job read every stage, resetting the start date of an active line, starting an ended line again, and linking an Asset to a line that was not started. A reviewer can repeat any of them.
- A reviewer should check that the commit holds the two test files and nothing else.
