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

The confirmation is recorded as a sighting at the instant of the confirmation, never earlier. The
go-live then takes its time from `decideInService`, which takes the first sighting at or after the
install. For an Asset never seen since its install, the confirmation is that first sighting, so the
go-live time is the confirmation instant. The one case that differs is an Asset that was seen but
stayed pending because its Subscription line could not be started. Its go-live time is the earlier,
real sighting, and the confirmation only tries the go-live again.

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
