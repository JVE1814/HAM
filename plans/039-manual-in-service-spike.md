# Plan 039: Draft the design of a manual in-service confirmation, with its open decisions

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **This plan writes one document and nothing else.** It edits no source file
> and contacts no instance. The feature it describes is built by a later plan,
> after the owner has answered the open decisions. See "STOP conditions".
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- plan.md CONTEXT.md docs/spec/p1-fulfilment.md docs/spec/p2-assurance.md docs/adr/0002-lifecycle-stage-lives-in-install-status-and-substatus.md docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md docs/research src/server/domain/in-service.ts src/server/platform/in-service.ts src/server/domain/vocabulary.ts src/server/domain/reconciliation.ts src/server/platform/reconciliation.ts src/server/domain/lifecycle.ts src/server/domain/lock-names.ts src/server/entry/billing.ts src/fluent/fleet/logic.now.ts src/client/workspace/dashboard.ts`
> Other plans of this batch may have changed some of these files. Step 1 tells
> you which facts must still hold. A step 1 check that fails is a STOP
> condition, with one named exception (the go-live time, plan 035).

## Status

- **Priority**: P3
- **Effort**: M (coarse: this spike is S, the build it prepares is M)
- **Risk**: MED for the build it prepares (it starts billing with no machine evidence). LOW for this plan (one new document).
- **Depends on**: none. If `plans/035-*.md` exists, read its title and "Why this matters" before step 3.
- **Category**: direction
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

An Asset goes in service, and its Subscription line starts billing, only when monitoring sees it
after its install. An Asset installed at a Site where no Discovery, connector or NMS reports it is
never seen. It stays pending in service, its Subscription line never starts, and the Provider never
bills it. `plan.md` promises a manual override for exactly this case and marks it "(not built)".
The only route today is an asset manager editing the stage on the Asset form, which starts no
Subscription line and leaves the Asset flagged as unseen for good.

This plan is a design spike. It writes `docs/research/manual-in-service.md`: the design, the rules
it must keep, the checks only an instance can make, and nine decisions for the owner, each with a
recommended answer. It builds nothing. A confirmation by hand starts billing without evidence, so
the owner decides who may give it and what it records before any code is written.

## Current state

### What the plan and the vocabulary promise

- `plan.md:601-602`:

  ```md
  - **Manual override:** a `UiAction` with a mandatory reason, for sources that are not yet connected
    (not built).
  ```

- `src/server/domain/vocabulary.ts:129-136`. The choice value exists and is installed with the
  column. Nothing writes it:

  ```ts
  /** alm_hardware.x_daas_ham_seen_source: what last confirmed the Asset is there. */
  export const SEEN_SOURCE_CHOICES = {
      discovery: { label: 'Discovery', sequence: 0 },
      connector: { label: 'Service Graph Connector', sequence: 1 },
      nms: { label: 'Provider NMS', sequence: 2 },
      manual: { label: 'Manual confirmation', sequence: 3 },
  } as const
  export type SeenSource = keyof typeof SEEN_SOURCE_CHOICES
  ```

- `src/server/domain/vocabulary.ts:169-174`. Device events leave `manual` out on purpose:

  ```ts
  /** The Seen sources a Device event comes from: monitoring only, never a person's confirmation. */
  export const DEVICE_EVENT_SOURCE_CHOICES = {
      discovery: SEEN_SOURCE_CHOICES.discovery,
      connector: SEEN_SOURCE_CHOICES.connector,
      nms: SEEN_SOURCE_CHOICES.nms,
  } as const
  ```

- `docs/spec/p1-fulfilment.md:281-287` (section "In service and billing start"):

  ```md
  - Seen signals:
    - NMS events through `POST /api/x_daas_ham/naas/device_events`;
    - the Asset's CI `last_discovered`, read for pending Assets by the detection job (its interval is
      in `in-service/in-service.now.ts`).
  - An Asset is in service at the first sighting at or after its install completion. A temporary Order
    gives a temporary deployment instead.
  ```

- `src/client/workspace/dashboard.ts:83-90`. The tile that counts the stuck Assets. Its list is
  `assets_pending_in_service` in `src/client/workspace/catalog.ts:143-149`:

  ```ts
              {
                  id: 'pending_in_service',
                  chart: 'score',
                  title: 'Installed, not yet seen',
                  span: 3,
                  source: { table: 'alm_hardware', filter: FLEET_IN_STAGE.pending_in_service },
                  drill: 'assets_pending_in_service',
              },
  ```

### The go-live path a manual confirmation reuses

`src/server/domain/in-service.ts:19-26`, the pure decision:

```ts
export function decideInService(facts: InServiceFacts): InServiceDecision {
    if (facts.stage !== 'pending_in_service') return { goesLive: false, reason: 'not pending in service' }
    if (facts.installCompletedAt === undefined) return { goesLive: false, reason: 'install not completed' }
    if (facts.lastSeenAt === undefined || facts.lastSeenAt < facts.installCompletedAt) {
        return { goesLive: false, reason: 'not seen since install' }
    }
    return { goesLive: true, at: facts.lastSeenAt, stage: facts.temporary ? 'temporary_deployment' : 'in_service' }
}
```

`src/server/platform/in-service.ts:21-26`, the only writer of the Seen source in the app's server
code (the demo data aside):

```ts
function recordSeen(asset: GlideRecord, at: number, source: SeenSource): void {
    const previous = glideToMs(str(asset, 'x_daas_ham_last_seen'))
    if (previous !== undefined && previous >= at) return
    asset.setValue('x_daas_ham_last_seen', msToGlide(at))
    asset.setValue('x_daas_ham_seen_source', source)
}
```

`src/server/platform/in-service.ts:33-56`, the go-live (comment lines left out):

```ts
function goLiveIfSeen(lock: HeldLock, asset: GlideRecord, readers: LifecycleReaders): boolean {
    const stage = readStage(asset)
    const decision = decideInService({
        stage,
        installCompletedAt: glideToMs(str(asset, 'x_daas_ham_install_completed')),
        lastSeenAt: glideToMs(str(asset, 'x_daas_ham_last_seen')),
        temporary: stage === 'pending_in_service' && choice<OrderType>(asset, 'x_daas_ham_order_line.order.order_type') === 'temporary',
    })
    if (!lock.held()) return false
    if (!decision.goesLive || !attachToSubscription(asset, decision.at)) {
        if (asset.update()) return true
        log.error(`in-service detection: sighting of ${str(asset, 'serial_number')} not saved: ${refusal(asset)}`)
        return false
    }
    asset.setValue('x_daas_ham_in_service_date', msToGlide(decision.at))
    applyLifecycleDates(asset, readers)
    if (moveAndSave(asset, decision.stage, 'in-service detection')) return true
    ...
}
```

`src/server/platform/in-service.ts:69-80`, the sighting lock. `recordSeen`, `goLiveIfSeen` and
`underSeenLock` are not exported. The module exports `applyDeviceEvents`,
`detectPendingInService` and `purgeDeviceEventsOlderThan` only:

```ts
function underSeenLock(assetId: string, see: (lock: HeldLock, asset: GlideRecord) => boolean): boolean {
    const seen = withLockTries(
        LOCK.seenAsset(assetId),
        (lock) => {
            // Read past the visibility rules, as the identifier lookup finds it; its save runs every rule.
            const asset = findById('alm_hardware', assetId, { beyondVisibility: true })
            return !asset || see(lock, asset)
        },
        LONG_HOLD_LOCK_TRIES,
    )
    return seen.ran && seen.value
}
```

`src/server/platform/subscriptions.ts:19` `attachToSubscription(asset, inServiceAt)` chooses the
Subscription line and starts a pending one under `LOCK.subscriptionLine`. Its only caller is
`goLiveIfSeen` (`in-service.ts:44`).

### What a form edit does today

- `src/server/domain/lifecycle.ts:75` allows the move, so an asset manager may set the stage on the
  Asset form: `pending_in_service: ['in_service', 'temporary_deployment', 'pending_return', 'missing'],`
- `docs/verify-on-instance.md:818-819` names that route: "an asset manager moving the replacement
  unit to in service on the Asset form".
- `src/server/entry/billing.ts:106-115`, the after rule *NaaS - start or stop billing on service*.
  It opens a Service interval only when the Asset already carries a Subscription line:

  ```ts
  export function onAssetServiceChange(current: ForeignRecord, previous: ForeignRecord): void {
      const change = billingChange(readStage(previous), readStage(current), {
          inServiceDate: glideToIsoDate(str(current, 'x_daas_ham_in_service_date')),
          today: todayIso(),
      })
      if (!change) return
      const lineId = str(current, 'x_daas_ham_subscription_line')
      if ('stop' in change) closeServiceIntervals(current.getUniqueValue(), change.stop)
      else if (lineId) openServiceInterval(current, lineId, change.start)
  }
  ```

  So a form edit sets no in-service date, attaches no Subscription line and starts no pending line.

### The reconciliation check a confirmed Asset meets

- `src/server/domain/lifecycle.ts:44`: `export const IN_USE_STAGES: readonly Stage[] = ['in_service', 'temporary_deployment']`.
  `src/server/platform/reconciliation.ts:33` reconciles those stages only, so an Asset pending in
  service is not checked.
- `src/server/domain/reconciliation.ts:87-89`:

  ```ts
  export function reconcileAsset(asset: InstalledAssetView, now: number, unseenDays: number): ExceptionType[] {
      const exceptions: ExceptionType[] = []
      if (asset.lastSeenAt === undefined || now - asset.lastSeenAt > unseenDays * 86_400_000) exceptions.push('unseen')
  ```

- `src/server/domain/properties.ts:28`: `unseenDays: { name: 'x_daas_ham.reconciliation.unseen_days', default: 7 },`
- `docs/spec/p2-assurance.md:64`: `- **unseen**: no Seen signal for `x_daas_ham.reconciliation.unseen_days`, or never seen;`

### The precedent for a UI action on the Asset

`src/fluent/fleet/logic.now.ts:51-65`. `alm_hardware` is a table of another scope:

```ts
UiAction({
    $id: Now.ID['ua_asset_add_to_fleet'],
    name: 'Add to fleet',
    table: 'alm_hardware',
    actionName: 'x_daas_ham_add_to_fleet',
    hint: 'Make this asset part of the NaaS fleet, so NaaS asset management sources, stages, tracks and bills it.',
    condition: CURRENT_NOT_FLEET,
    roles: [assetManager, admin],
    form: { showButton: true },
    list: { showListChoice: true },
    // An Asset is adopted once saved: a new one the app creates is a fleet asset already (platform/assets newAsset).
    showInsert: false,
    showUpdate: true,
    script: uiAddToFleet,
})
```

Its script, `src/server/entry/fleet.ts:11-17`, saves the form first and says why when it refuses:

```ts
export function uiAddToFleet(current: GlideRecord): void {
    if (!current.update()) return
    const name = str(current, 'asset_tag') || str(current, 'serial_number') || str(current, 'display_name')
    const problem = adoptIntoFleet(current, name)
    if (problem) return void gs.addErrorMessage(`${name} not added to the fleet: ${problem}`)
    gs.addInfoMessage(`${name} added to the fleet`)
}
```

The app ships a `Form` for each of its own tables and none for `alm_hardware`. So a column the app
adds to the Asset is not on the Asset form unless an administrator puts it there.

### Rules and words the design must keep

- `CONTEXT.md`, quoted:
  - "**In service**: An Asset installed at a Site and seen by monitoring; the moment billing starts. _Avoid_: live, active, deployed"
  - "**Seen signal**: Evidence from Discovery, a connector or the Provider's NMS that an Asset is alive on the network. _Avoid_: heartbeat, ping"
  - "**Lifecycle stage**: Where an Asset is in its life (e.g. available, staging, in service, pending return), expressed through the platform's install status and substatus."
  - "**Reconciliation exception**: A disagreement between Assets and monitoring (seen but unknown, deployed but unseen, serial or location mismatch), ..."
  - "**Attestation**: A Customer admin's periodic confirmation of the Assets installed at their Sites."
  - Use Asset, Site, Customer, Provider, Subscription line, Service interval. Avoid device (for the record), live, deployed, heartbeat.
- ADR 0002 (`docs/adr/0002-lifecycle-stage-lives-in-install-status-and-substatus.md`): "there is no
  scoped "stage" field" and "every change made by this app goes through one transition function".
- ADR 0013 (`docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md`): "Only the
  device-events REST handler and the in-service detection job take `seen_asset_<sys_id>`, and they
  hold no other lock when they do." Locks are taken in the order `LOCK` declares them
  (`src/server/domain/lock-names.ts`). `seenAsset` is at line 37, before `subscriptionLine` and
  `serviceInterval`.
- ADR 0016: the app acts on Fleet assets only.
- README "Development": a before rule on a table of another scope cannot call
  `current.setAbortAction`. The name of a UI action fits 40 characters. A `.now.ts` file holds
  constants only.
- Prose: short declarative sentences, sentence-case headings, no em dashes.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Lint | `npm run lint` | exit 0 |
| What changed | `git status --short` | only `docs/research/manual-in-service.md` (and files under `plans/`) |

Do not run `npm run build`, `npm run check`, `npm run deploy` or any `now-sdk` command. The build
rewrites the tracked `src/fluent/generated/keys.ts`, and this plan changes no source.

## Scope

**In scope** (the only file you create):

- `docs/research/manual-in-service.md` (create)

**Out of scope** (do NOT touch, even though they look related):

- Everything under `src/`. No UI action, no server function, no test, no column.
- `plan.md`, `CONTEXT.md`, `README.md`, `docs/spec/**`, `docs/adr/**`, `docs/verify-on-instance.md`.
  The follow-up build changes them, once the owner has decided.
- Any instance. No deploy, no script, no API call, no read.
- The open decisions. They are the owner's. Do not fill one in.

## Git workflow

- Branch: `advisor/039-manual-in-service-spike`
- One commit. Subject in the repo's style (an imperative sentence under 72 characters), for
  example: `Draft the manual in-service confirmation with its open decisions`. Body: what the
  document is for and that nothing is built yet.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the facts the document relies on

Run each command. The expected result follows it.

```sh
grep -n "Manual override" plan.md
grep -n "manual: { label: 'Manual confirmation'" src/server/domain/vocabulary.ts
grep -rn "setValue('x_daas_ham_seen_source'" src/server --include=*.ts | grep -v "\.test\.ts"
grep -n "^function recordSeen\|^function goLiveIfSeen\|^function underSeenLock" src/server/platform/in-service.ts
grep -rn "attachToSubscription(" src/server --include=*.ts | grep -v "\.test\.ts"
grep -n "IN_USE_STAGES: readonly Stage\[\] = " src/server/domain/lifecycle.ts
grep -n "lastSeenAt === undefined || now - asset.lastSeenAt" src/server/domain/reconciliation.ts
grep -n "else if (lineId) openServiceInterval" src/server/entry/billing.ts
grep -rn -A1 "^Form({" src/fluent --include=*.now.ts | grep -c "alm_hardware\|alm_asset"
grep -rl "pending_in_service\|device_events" src/fluent --include=tests.now.ts | wc -l
grep -c "Only the device-events REST handler and the in-service detection job take" docs/adr/0013-margin-recomputes-supersede-under-a-job-lock.md
grep -n "at: facts.lastSeenAt" src/server/domain/in-service.ts
find plans -name '035-*.md'; find docs/research -name 'manual-in-service.md'
```

**Verify**, in order:

1. One line, `plan.md:601`, that ends `for sources that are not yet connected`.
2. One line (line 134 at planning time).
3. Exactly one line: `src/server/platform/in-service.ts:25:    asset.setValue('x_daas_ham_seen_source', source)`.
4. Three lines, none starting with `export`.
5. Two lines: the call at `src/server/platform/in-service.ts:44` and the definition at `src/server/platform/subscriptions.ts:19`. No other caller.
6. One line ending `['in_service', 'temporary_deployment']`.
7. One line.
8. One line.
9. `0`.
10. `0` (no ATF test file names the stage or the device-events route).
11. `1`.
12. One line, or none. See below.
13. The second `find` prints nothing: `docs/research/manual-in-service.md` must not exist. The first may print a plan 035 file or nothing.

Check 12 is the one allowed difference. If it prints one line, the go-live time is still the
Asset's last sighting: use **variant A** in step 3. If it prints nothing, another plan (035) has
changed the go-live time: read `decideInService` in `src/server/domain/in-service.ts`, use
**variant B** in step 3, and say so in your report.

Any other difference is a STOP condition.

### Step 2: Create the document

Create `docs/research/manual-in-service.md` with the content below. Copy it as given, except the
one paragraph step 3 chooses. Do not answer an open decision.

````md
# Manual in-service confirmation: design draft

## Status

A draft for the owner to decide on. Nothing in it is built, and nothing in it has run on an
instance. The section "Open decisions for the owner" lists what must be answered before a build.
The section "Instance checks before the build" lists the platform facts this draft assumes and
could not confirm from the repository.

## What the plan asks for

`plan.md` section P1.8: "**Manual override:** a `UiAction` with a mandatory reason, for sources
that are not yet connected (not built)."

The need is commercial. An Asset goes in service at the first Seen signal at or after its install,
and that instant starts its Subscription line (`docs/spec/p1-fulfilment.md`, "In service and
billing start"). An Asset at a Site that no Discovery, connector or NMS reports is never seen. It
stays pending in service, its Subscription line never starts, and it is never billed. The workspace
counts these Assets on the tile *Installed, not yet seen* and lists them, and offers nothing to do
about them.

The stored value for this already exists: the Seen source *Manual confirmation* (`manual` in
`SEEN_SOURCE_CHOICES`, `src/server/domain/vocabulary.ts`). No code writes it.

## What happens today

- Install completion (*Confirm installed*, or the work order closed) sets the install time and
  moves the Asset to pending in service (`platform/delivery.ts` `completeInstall`).
- A Seen signal puts it in service: an NMS event through the device-events route, or the Asset's CI
  `last_discovered`, read by the detection job every 15 minutes. Both run `goLiveIfSeen`
  (`platform/in-service.ts`) under the Asset's sighting lock. It sets the in-service date, attaches
  the Asset to its Subscription line, starts a pending line, computes the lifecycle dates and moves
  the stage.
- The only route by hand is the Asset form. The lifecycle allows pending in service to in service,
  so an asset manager can set the stage there. That route runs none of the go-live. The rule *NaaS
  - start or stop billing on service* opens a Service interval only when the Asset already carries
  a Subscription line (`entry/billing.ts` `onAssetServiceChange`), and nothing else attaches one.
  So the Asset has no in-service date and starts no pending line, and it joins a Subscription line
  only if the asset manager also picks one by hand. Without one it shows on the tile *In service
  without a subscription line*. It has never been seen, so the daily reconciliation raises an
  *unseen* exception on it, which never clears.

## The design

### The action

A UI action *Confirm in service* on the Asset form (`alm_hardware`). It is offered on a Fleet
asset that is pending in service, and on no other Asset. Its record goes in
`src/fluent/in-service/in-service.now.ts`, as the README places a record with the feature whose
server module it serves. *Add to fleet* (`src/fluent/fleet/logic.now.ts`) is the precedent for a UI
action on this table: a server script that saves the form first, does its work, and says why when
it refuses.

`alm_hardware` is a table of another scope. A before rule there cannot refuse a save from its
script. The action needs no rule: its script refuses by changing nothing and telling the user why.

### Who may confirm

Proposed: asset managers, and app administrators, who hold that role. A confirmation starts billing
with no machine evidence. The asset manager already runs the lifecycle for every Customer and is
the role that can set the stage by hand today. A field tech's statement that the equipment is
installed is *Confirm installed*. A second statement by the same person adds no evidence. The NOC
knows which sources are connected, but it writes no Asset, so it cannot type on the Asset form.
See decision 1.

### The reason and the audit trail

The reason is mandatory. A confirmation with a blank reason changes nothing. Three places can hold
it. They differ in what the platform must do, which only an instance can confirm.

- **A work note on the Asset.** The user types the reason as a work note and presses the button.
  The script refuses when no note was typed. The Asset's activity then shows who confirmed, when,
  and why, beside the stage change. This is the smallest build: no column and no table. It needs
  instance checks 1 and 2.
- **A reason column on the Asset.** A list can show it. But the app lays out no Asset form, so the
  column is not on the form unless an administrator adds it, and a reason nobody can type is a
  button nobody can use.
- **A confirmation record on a table of the app's own** (the Asset, the reason, who, when, the
  outcome). The dictionary makes the reason mandatory, a rule on the app's own table can refuse,
  and the app's own ACLs decide who creates one, the NOC included. It is the most to build: a
  table, its ACLs, a form, a rule, and a way from the Asset to the new record.

Whichever holds the reason, the Asset itself records that it was confirmed by hand: its Seen
source reads *Manual confirmation* and its Last seen holds the time. See decision 2.

### The go-live

The confirmation runs the same go-live as a Seen signal, so that nothing is done twice or
differently:

1. The script saves the form and checks the reason.
2. A new function in `platform/in-service.ts` takes the Asset's sighting lock
   (`LOCK.seenAsset`), holding no other lock, and reads the Asset afresh there, as
   `underSeenLock` does for a sighting.
3. An Asset that is no longer pending in service is left alone, and the user is told. A sighting
   may have put it in service a moment earlier.
4. `recordSeen` writes the confirmation time as Last seen, with the Seen source `manual`.
5. `goLiveIfSeen` does the rest: the in-service date, the Subscription line (a pending one is
   started under `LOCK.subscriptionLine`), the lifecycle dates, and the move to in service, or to
   temporary deployment for a temporary Order.
6. The script reads the Asset's stage again and tells the user the result: in service, or still
   pending in service and why.

Pressing the button twice is harmless. The second press finds the Asset in service and changes
nothing. A confirmation whose Subscription line could not be started leaves the Asset pending in
service with the confirmation saved, as a sighting does, and the next press tries again.

A confirmation stores no device event. Device events come from monitoring only
(`DEVICE_EVENT_SOURCE_CHOICES` leaves `manual` out on purpose).

### The time of a manual go-live

GO_LIVE_TIME_PARAGRAPH

Backdating the go-live to the install time would bill the days between the install and the
confirmation. That is a commercial choice. See decision 4.

### Reconciliation

The daily reconciliation raises *unseen* on an Asset in service that has no Seen signal for
`x_daas_ham.reconciliation.unseen_days` (7 by default), or none at all. A confirmed Asset sits
where no source reports it, so it would be flagged a week after its confirmation and stay flagged
for good. One open exception per Asset, never resolved, is noise that hides the real ones.

Proposed: `reconcileAsset` (`domain/reconciliation.ts`) raises no *unseen* exception while the
Asset's Seen source is `manual`. The exemption ends by itself. The first real sighting is newer
than the confirmation, so `recordSeen` replaces the source, and from then on the Asset is checked
like any other.

This masks a dead device, and the draft says so plainly. An Asset confirmed by hand that later
fails or is taken away is not noticed by reconciliation. Three things limit that. The action is
offered only on an Asset pending in service, so it cannot silence an *unseen* exception on an Asset
that monitoring used to see. An Attestation asks the Customer admin to confirm the Assets at each
Site, and a Site audit counts them. And the workspace gets a list of the installed Assets whose
Seen source is manual, so the Provider knows which Assets nothing watches. See decision 5.

### What the action does not do

- It does not connect a source. The reason field is where the asset manager says why none reports.
- It does not undo. An Asset in service leaves by the usual moves (a Return order, declared
  missing). A Service interval opened by mistake is corrected by hand by the roles that edit
  intervals.
- It does not change the form edit described under "What happens today". See decision 9.

## Rules the design keeps

- **ADR 0002** (the Lifecycle stage lives in install status and substatus). The design adds no
  stage, no substatus and no stage field. The move goes through the one transition function, as
  `goLiveIfSeen` already calls `moveAndSave`.
- **ADR 0013** (job locks and their order). The confirmation takes `seen_asset_<sys_id>` holding no
  other lock, and everything taken under it (`subscription_line_`, then `service_interval_` in the
  save's rule) is declared later in `LOCK`. No lock is added. The ADR's sentence "Only the
  device-events REST handler and the in-service detection job take `seen_asset_<sys_id>`" and the
  comment on `seenAsset` in `domain/lock-names.ts` must name the confirmation as a third taker.
- **ADR 0003** (pure domain, Glide in `platform/`, thin `entry/`). The reason check and the
  reconciliation exemption are pure functions in `domain/`. The go-live stays in `platform/`. The
  UI action's script is a thin function in `entry/in-service.ts`.
- **ADR 0016** (Fleet assets only). The action is offered on Fleet assets only.
- **ADR 0009** (billing from Service intervals). The Service interval opens from the in-service
  date through the existing rule. The design adds no second way to start billing.
- **CONTEXT.md**. The glossary defines In service as "installed at a Site and seen by monitoring"
  and a Seen signal as evidence from Discovery, a connector or the NMS. A confirmation by hand is
  neither. The build must change the glossary in the same commit. See decision 8.

## Instance checks before the build

None of these writes data that matters, but each needs a dev instance, so none was run for this
draft.

1. **Work notes on the Asset.** Open *System Definition > Dictionary* filtered to table `alm_asset`
   and column name `work_notes`. Expected: one journal input column. Open any hardware Asset form.
   Expected: the work notes field is on the form or in its activity. If either fails, the work-note
   option of decision 2 is out.
2. **A typed work note in a UI action's script.** On a dev instance, make a throwaway server-side
   UI action on `alm_hardware` with the script
   `gs.addInfoMessage('note: [' + current.work_notes + ']')`. Type a work note on an Asset form
   and press the action without saving first. Expected: the message shows the typed text. If it shows nothing, the script cannot tell that a reason was
   typed, and the work-note option is out. Delete the throwaway action afterwards.
3. **The action on the form.** After the build is installed: as an asset manager, a pending Asset
   shows *Confirm in service*; an Asset in service, an Asset outside the fleet, and any Asset
   opened by a field tech or the NOC do not.
4. **The go-live as a user.** As an asset manager who is not an administrator, press the action on
   a pending Asset whose Subscription line is pending. Expected: the Asset is in service, its Seen
   source reads *Manual confirmation*, the line is active with today's start date, and one Service
   interval is open. The sighting lock row is gone afterwards (*Job locks*).
5. **Reconciliation.** Run *NaaS - reconcile installed base* (*Execute now*). Expected: no *unseen*
   exception on the confirmed Asset. Then send one NMS `seen` event for it. Expected: its Seen
   source reads *Provider NMS*.

## Tests

- Vitest, on the fake Glide (`src/server/platform/in-service.test.ts`, which already tests the
  go-live): a confirmation puts a pending Asset in service with the source `manual` and starts its
  pending line; a temporary Order gives a temporary deployment; an Asset not pending is left alone;
  a held sighting lock changes nothing; a line that cannot be started leaves the Asset pending with
  the confirmation saved; no device event is stored.
- Vitest, pure (`src/server/domain/reconciliation.test.ts`): no *unseen* while the source is
  `manual`; *unseen* again once a later sighting is older than the limit.
- ATF: the app has no ATF test of in-service detection today. The build adds
  `src/fluent/in-service/tests.now.ts`, in the P1 suite: the action's visibility by role and by
  stage, a blank reason refused, and the go-live through the form button. ATF runs on an instance
  only (`docs/verify-on-instance.md#running-atf`).
- The fake Glide runs no business rule, ACL or UI action condition. Who sees the button and what
  the form save does are ATF's and the instance checks' to show.

## Open decisions for the owner

Each has a recommended answer. None is taken until the owner says so.

1. **Who may confirm?** Recommended: asset managers only (and app administrators, who hold the
   role). It starts billing without evidence, and that role already owns the lifecycle. Adding the
   NOC needs the confirmation-record option of decision 2, because the NOC cannot type on an Asset
   form.
2. **Where is the reason typed and kept?** Recommended: a work note on the Asset, if instance
   checks 1 and 2 pass. It is the smallest build and the Asset's activity is the audit trail. If
   either check fails: a confirmation record on a table of the app's own. Not recommended: a
   reason column on the Asset, since the app lays out no Asset form.
3. **Does a confirmation set Last seen and the Seen source?** Recommended: yes, the confirmation
   time and `manual`. The column's own description is "what last confirmed the Asset is there",
   the value exists, and the go-live then runs unchanged. The cost: Last seen holds a time at
   which no monitoring saw the Asset, told apart only by the source beside it.
4. **Which time does a manual go-live take?** Recommended: the instant of the confirmation.
   Billing starts when the Provider records the evidence, as it does for a Seen signal, and
   nothing is billed in arrears. The alternative is the install time, which bills the days in
   between.
5. **Is a confirmed Asset exempt from the *unseen* check?** Recommended: yes, while its Seen source
   is `manual`, with no time limit, and with a workspace list of those Assets. The alternative is a
   limit in days after which the confirmation must be repeated. That brings back the daily noise
   for every Site without a source, and Attestation already asks the Customer to confirm presence.
6. **One Asset at a time, or many?** Recommended: the form button only, in the first build. A Site
   without a source may hold dozens of Assets, so a list choice or a Site-wide confirmation may be
   wanted later. Each needs its own answer to where one reason for many Assets is typed.
7. **Is a confirmation ever refused or delayed?** Recommended: no further guard. Candidates are a
   minimum wait after the install (the detection job runs every 15 minutes), and a refusal when
   the Asset's CI has ever been discovered. Both guess at whether a source is connected, which the
   asset manager knows and states in the reason.
8. **What does the glossary call it?** Recommended: add the term **Manual confirmation** to
   `CONTEXT.md` ("An asset manager's recorded statement, with a reason, that an installed Asset is
   working where no Seen signal can reach the Provider"), keep **Seen signal** for monitoring
   only, and widen **In service** to "seen by monitoring or confirmed by hand". `plan.md` says
   "manual override"; the stored label already says *Manual confirmation*.
9. **Does the form edit stay?** Today an asset manager can set a pending Asset in service on the
   form, which starts no Subscription line. Recommended: leave it in the first build and point
   the docs at the action. Refusing that edit changes the lifecycle rule (ADR 0002) and the route
   `docs/spec/p2-aftersales.md` names for completing a replacement Order.

## Follow-up build outline

For a build plan, written once the decisions are answered. It assumes the recommended answers.

1. `src/server/domain/in-service.ts`: a pure check of the reason, with its tests.
2. `src/server/platform/in-service.ts`: an exported function that confirms one Asset by hand under
   its sighting lock, built on `underSeenLock`, `recordSeen` and `goLiveIfSeen`, with the tests
   listed above.
3. `src/server/entry/in-service.ts`: the UI action's script, named after the platform global
   (`current`).
4. `src/fluent/in-service/in-service.now.ts`: the `UiAction`, with `$id: Now.ID['...']`, a name
   within 40 characters, and a condition within 254 characters built from constants of
   `domain/fleet.ts` and `domain/vocabulary.ts`. `src/fluent/generated/keys.ts` is regenerated by
   the build and committed.
5. `src/server/domain/reconciliation.ts` and `src/server/platform/reconciliation.ts`: the Seen
   source in the Asset's view, and no *unseen* while it is `manual`, with tests.
6. `src/client/workspace/catalog.ts`: a list of the installed Fleet assets whose Seen source is
   manual, with the fleet condition in every clause, which `catalog.test.ts` checks.
7. `src/fluent/in-service/tests.now.ts` and `src/fluent/shared/test-suites.now.ts`: the ATF test.
8. Docs in the same commits: `CONTEXT.md` (decision 8), `docs/spec/p1-fulfilment.md` ("In service
   and billing start"), `docs/spec/p2-assurance.md` (the *unseen* check), ADR 0013 and the
   `seenAsset` comment in `domain/lock-names.ts` (a third taker), `plan.md` (the words "(not
   built)"), the README where it describes Seen signals, and `docs/verify-on-instance.md`
   (instance checks 3 to 5).
9. `npm run check`, then the instance checks and the ATF run, which the plan must report as not
   run when no instance is at hand.
````

**Verify**: `test -f docs/research/manual-in-service.md && echo exists` → `exists`.

### Step 3: Put in the paragraph on the go-live time

The document holds one placeholder line, `GO_LIVE_TIME_PARAGRAPH`. Replace that line with one of
the two paragraphs below, as step 1 check 12 told you.

**Variant A** (the check printed one line: `at: facts.lastSeenAt`):

```md
The confirmation is recorded as a sighting at the instant of the confirmation, never earlier. The
go-live then takes its time from `decideInService`, which today returns the Asset's Last seen. A
pending Asset has no sighting since its install, or it would be in service, so the go-live time is
the confirmation instant. Another plan of this batch (035) may change the rule to the first
sighting after the install. The result is the same: for an Asset never seen since its install, the
confirmation is that first sighting. The one case that differs is an Asset that was seen but stayed
pending because its Subscription line could not be started. Under that rule its go-live time is the
earlier, real sighting, and the confirmation only tries the go-live again.
```

**Variant B** (the check printed nothing, so the go-live time has changed):

```md
The confirmation is recorded as a sighting at the instant of the confirmation, never earlier. The
go-live then takes its time from `decideInService`, which takes the first sighting at or after the
install. For an Asset never seen since its install, the confirmation is that first sighting, so the
go-live time is the confirmation instant. The one case that differs is an Asset that was seen but
stayed pending because its Subscription line could not be started. Its go-live time is the earlier,
real sighting, and the confirmation only tries the go-live again.
```

With variant B, read `decideInService` first. If it does not take the first sighting at or after
the install, that is a STOP condition: report what it does instead.

**Verify**:
`grep -c "GO_LIVE_TIME_PARAGRAPH" docs/research/manual-in-service.md` → `0`.
`grep -c "The confirmation is recorded as a sighting at the instant of the confirmation" docs/research/manual-in-service.md` → `1`.

### Step 4: Check the document's shape

```sh
grep -c "^## " docs/research/manual-in-service.md
grep "^## " docs/research/manual-in-service.md
grep -c "^### " docs/research/manual-in-service.md
grep -c "^[0-9]*\. \*\*" docs/research/manual-in-service.md
grep -n "TODO\|TBD" docs/research/manual-in-service.md
```

**Verify**:

- `9`.
- The nine headings, in this order: `## Status`, `## What the plan asks for`,
  `## What happens today`, `## The design`, `## Rules the design keeps`,
  `## Instance checks before the build`, `## Tests`, `## Open decisions for the owner`,
  `## Follow-up build outline`.
- `7` (the subsections of "The design").
- `14` (five instance checks and nine open decisions).
- Nothing printed.

### Step 5: Run lint and commit

Run `npm run lint`, then `git status --short`.

**Verify**: lint exits 0. `git status --short` lists `docs/research/manual-in-service.md` as new
and, apart from files under `plans/`, nothing else. In particular nothing under `src/`.

Commit the one file.

### Step 6: Hand back and stop

Report to the operator:

1. The file created, and which variant step 3 used.
2. The nine open decisions, word for word, each with its recommended answer.
3. The five instance checks, and that none was run.
4. That nothing is built: no source file changed and no instance was contacted.

Then stop. Do not start the build, even if the decisions look obvious.

## Test plan

This plan adds no code, so it adds no test. Its checks are those of steps 1, 3, 4 and 5: the facts
hold, the document has its named sections and its numbered decisions, and lint passes with only
the one file changed. The document's own "Tests" section says what the build must test.

## Done criteria

ALL must hold:

- [ ] `docs/research/manual-in-service.md` exists with 9 `## ` sections, 7 `### ` subsections and 14 numbered bold items
- [ ] `grep -c "GO_LIVE_TIME_PARAGRAPH" docs/research/manual-in-service.md` prints `0`
- [ ] `grep -n "TODO\|TBD" docs/research/manual-in-service.md` prints nothing
- [ ] `npm run lint` exits 0
- [ ] `git diff --stat 805d5da..HEAD -- src` shows no change made by this plan
- [ ] `git status --short` lists no file outside the in-scope list (files under `plans/` aside)
- [ ] No instance was contacted, and the report says so
- [ ] The report lists the nine open decisions and the five instance checks
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- A step 1 check differs from its expected result, other than check 12. In particular: something
  besides `recordSeen` now writes `x_daas_ham_seen_source` (the confirmation may be built already),
  `goLiveIfSeen` is gone or renamed, or `docs/research/manual-in-service.md` already exists.
- Check 12 printed nothing and `decideInService` does not take the first sighting at or after the
  install.
- Any step would edit a file under `src/`, or `plan.md`, `CONTEXT.md`, `README.md`, a spec, an ADR
  or `docs/verify-on-instance.md`. Those edits belong to the build.
- Any step would contact an instance: `npm run deploy`, `now-sdk install`, a Table API call, a
  script pasted into *Scripts - Background*, an ATF run. The instance checks in the document are
  for the owner or the build plan, not for you.
- You are asked, or tempted, to answer an open decision, or to write the UI action "while you are
  here". The owner decides first.
- `npm run lint` fails. This plan adds one Markdown file, so a lint failure comes from elsewhere:
  report it, do not fix it.

## Maintenance notes

- The document quotes behaviour, not line numbers, so it survives small edits. Three things make
  it stale: a change to how `goLiveIfSeen` attaches a Subscription line, a change to the *unseen*
  check, and an Asset form layout shipped by the app (which reopens decision 2).
- Plan 035 of this batch may change the go-live time. Step 3 covers both orders of landing. If 035
  lands after this plan, replace the paragraph under "The time of a manual go-live" with variant B.
- The build plan must be written against the owner's answers. Decision 2 changes its size most: a
  work note is a UI action and two functions, a confirmation record is a table with ACLs, a form
  and a rule.
- Decision 9 is the one with a cost of waiting. While the form edit stays, an asset manager can
  still put an Asset in service with no Subscription line. The tile *In service without a
  subscription line* is what shows it.
- Reviewer: check that the document recommends and does not decide, that it says plainly that the
  exemption masks a dead device, and that it names ADR 0002, 0003, 0009, 0013 and 0016.
