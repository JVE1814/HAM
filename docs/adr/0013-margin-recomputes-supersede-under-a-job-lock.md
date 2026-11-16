# Margin recomputes supersede each other under a job lock

A fresh *Recompute margin* supersedes one still running, and an older pass must not write after the
fresh one has started: its Cost facts would sit beside the fresh pass's, or its completion would
replace the fresh Margin. Checking "still current?" before each write leaves the instant between the
check and the write open, so the event runner makes the check and the write one critical section. A
pass's start (new token, period cleared), each chunk's flush (Cost facts and failure counts) and the
pass's completion (field labour, Margin) hold the job's lock, and each checks under it that its pass
is still the current one. A fresh pass can then only start between them, and a superseded chunk
writes nothing.

`GlideMutex` is not available to scoped applications, so the lock is a row in `x_daas_ham_job_lock`
behind a unique index: taking it is one insert that only one holder wins, and releasing it deletes the
row. A chunk that finds the lock held writes nothing and runs again later (`REQUEUE.delaySeconds` in
`src/server/domain/job-lock.ts`, which owns every number of this ADR) from the same
pass and cursor, so nothing is lost or written twice; that holds because a superseding job's `handle`
only accumulates in memory and every write happens under the lock. A lock held for longer than
`ABANDONED_AFTER_MINUTES` is
taken as abandoned (its holder's transaction died) and cleared by the next taker, so a crash delays
recomputes instead of stalling them. A holder that is in fact still running is not stopped, and what it
writes then sits beside the pass that took over. So after each write under the lock (the start, each
flush and the completion), and when one throws, the holder checks that it still holds the lock. One
that lost it writes nothing more, throws nothing, logs *job lock lost while writing* and at once queues
another fresh pass, which supersedes the one that took over, clears the period and recomputes it. Until
that pass completes, the Margin can be wrong (the pass that took over may complete first and count the
lost holder's Cost facts), and a write that keeps outlasting that time restarts the recompute
again each time. Both need a single write to run that long, so they are accepted. Renewing the lock as
it is held (a heartbeat) would not close the gap: it can only be renewed between writes, not during the
write that overruns, and no write can be tied to the lock in a transaction.

A chunk that throws while it still holds the lock records why on the period, under the lock and only
for the current pass; a stop that cannot be recorded on the period is logged. A start whose job cursor
(the new token) is refused throws before `onStart`, so it clears nothing and, never having become the
current pass, is only logged. A take whose second insert is refused, and whose holder lets go before
the check, tries the insert once more. Only an insert refused while no lock row exists throws, instead
of retrying forever.

Order sourcing takes a lock of the same kind on each Order but does not supersede: a pass that finds
it held is queued again `REQUEUE.delaySeconds` seconds later, at most `REQUEUE.times` times, because
a purchase already requested
cannot be cleared the way a recompute clears its period. *Cancel order* takes the same lock, so a
cancel and a pass take turns; a cancel that finds it held changes nothing and asks the user to try
again. Under it, *Cancel order* also takes the Order's Ship lock (`ship_order_<Order sys_id>`), so a
Ship cannot run between its shipped check and its release of the lines; one that finds it held
changes nothing and says a Ship of the Order is running, without retrying. It is the only holder of
both, and Ship never takes `source_order_`, so `source_order` stays before `ship_order`. Under its
Ship lock, *Cancel order* also takes the `order_line_<line sys_id>` lock of each of the Order's lines
not yet shipped, `LONG_HOLD_LOCK_TRIES` tries each, and saves the Order, releases each line's units
and cancels the line
only once it holds them all; one that finds a line's lock held changes nothing and asks the user to
try again. A receipt for a waiting line saves its unit, takes it off order, reserves it and stages it
(its Staging task opened, the move into staging saved) under that line's lock, and reads the line and
its Order again there: the unit goes only to a line still awaiting stock on an Order neither
cancelled nor rejected. So a receipt lands wholly before the cancel reads the line's units, or finds
the line and its Order cancelled. An Order's rejection holds the same line locks while it saves the
Order rejected and cancels its lines; one that finds a line's lock held changes nothing, and the
Order stays awaiting approval, to re-check. A line's stage derived from its Assets takes no lock, so
a derive that read the line before a cancel is not saved once the line is cancelled or its Order has
ended, and a line whose Order ended while its derived stage was saved is cancelled again
(`platform/fulfilment.ts` `deriveLine`): a derive never reopens a cancelled line. An Order's stage
derived from its lines takes no lock either: a derive that read the Order before a cancel and saved
its stage after leaves the cancel's Closed Skipped state beside it, as a save writes only the fields
it changed, so an Order read so just after the save is saved cancelled again (`recomputeOrder`).
A submission holds `source_order_` from its fresh read of the Order through its save out of draft
(below), so a cancel never lands between them. The daily
refresh run holds `refresh_orders`, a lock of the same kind, and, like *Cancel order*, does not
retry: a run that finds its lock held raises nothing and leaves it to the run holding it. Short
critical sections, such as an Order line, an Agreement's submissions, an ASN row's serial, the
Provider tag counter, a stock change, a Service interval, a Subscription line's start, a sighting or a
tracking update, take locks of the same kind and, finding one held, try again back to back
(`LOCK_TRIES` times, or `LONG_HOLD_LOCK_TRIES` where the holder keeps the lock through several saves;
`withLockTries` and `attemptLock` in `platform/locks.ts`) before they give up. A tracking update
that gives up is not left to the
aggregator (ShipEngine resends it at most twice, typically 30 minutes apart, then drops it): it is
queued as an event that tries the lock again, then `REQUEUE.delaySeconds` seconds apart, at most
`REQUEUE.times` more times.

Locks are not re-entrant: a holder that takes a lock it already holds is refused, as any other taker
would be. A take never waits either: it tries and gives up. So locks are taken in one order, and a
holder only takes locks later in it than those it holds. The order is the order `LOCK` declares the
locks in (`src/server/domain/lock-names.ts`), and nowhere else. A holder that takes several locks of
one kind takes them one under another in sys_id order. Only *Cancel order* and an Order's rejection do,
holding the `order_line_` lock of each of the Order's open lines at once. A take never waits, so this
cannot deadlock; the sys_id order only makes two such holders of one Order meet at the same line
first. Every other holder of an `order_line_` lock holds one at a time and takes nothing earlier in
the order under it, and two cancels of one Order exclude each other through `source_order_`.

Only the device-events REST handler and the in-service detection job take `seen_asset_<sys_id>`, and
they hold no other lock when they do. The go-live under it starts its pending Subscription line
under `subscription_line_<line sys_id>` and releases it before the go-live save takes
`service_interval_<sys_id>`. Nothing takes `subscription_line_` except that go-live, and nothing is
taken under it. `refresh_orders` is held by the daily refresh run for the whole run, and the run
holds no other lock when it takes it. The Orders it raises are inserted and submitted under it. Each
of their lines replaces an Asset, so their submit reads no usage and takes only the Order's
`source_order_` (below), and sourcing runs from the queued event. It comes first all the same, ahead
of `agreement_usage`, which a submit of an Order with a line that adds a unit takes.
Submitting an Order assesses it against its Agreement's usage (deployed units plus the quantities of
its other Orders in flight, `domain/entitlement.ts`) and then saves it out of draft, from which save
on it counts in flight. Two submissions of one Agreement that both read before either saved would
each miss the other, and could both go ahead within a Contracted quantity only one fits, with no
over-quota approval. So a submission holds `agreement_usage_<Agreement sys_id>` from its fresh read of
the Order, its lines and the Agreement's quantities and usage through the save that takes the Order
out of draft, and goes on only from draft, under the Agreement and Customer it locked and checked:
a second submission of the same Order finds it gone ahead and says so. *Submit*, the record
producer and a submission queued again take it holding no lock, and *Raise replacement* holding
only its case's lock (`replacement_case_`, below). An Order whose
lines all replace Assets (break-fix, refresh) is assessed the same whatever is in flight, and its
lines going into flight beside a holder's read of usage read as if it had come first or last, so its
submit takes no usage lock. Under the usage lock, or holding nothing for such an Order, a submission
takes the Order's `source_order_`, `LONG_HOLD_LOCK_TRIES` tries back to back, so a *Cancel order*
saved after its read
of the draft is not overwritten by its save; one that finds it held submits nothing and says the
Order is being cancelled. A submission that finds the lock held through those tries leaves the
Order a draft, noted, and queues it to be submitted again `REQUEUE.delaySeconds` seconds later (the
sourcing event with
parm1 `submit`), at most `REQUEUE.times` times, then logs it for staff to submit; the producer's
raiser, who may
have no *Submit*, is told it is submitted within minutes and not to raise it again. Under the lock a
submit only reads, requests approvals (and cancels them when it cannot go ahead, which runs the
approval rollup rule: it finds the Order a draft and takes nothing), saves the Order (no rule of the
app is on it) and queues its sourcing, which takes `source_order_` in its own transaction holding
nothing, once the submission has let it go. A submit that outlasts the lock logs that the
Order was submitted after its usage lock was lost.
The lock orders submissions only: usage that changes without one (a line added to an Order already
submitted, its Agreement changed, Assets adopted into the Agreement) is not assessed.
*Raise replacement* on a case runs under `replacement_case_<case sys_id>`, holding no other lock
when it takes it: it reads the Order the case links afresh there, raises the replacement Order,
links it to the case and submits it. Two presses at once would otherwise each find the case
linking no Order and raise one each, the first left going ahead unlinked. It does not retry: a
press that finds the lock held raises nothing and says a replacement is being raised. Under it,
the submission takes the Order's `source_order_` and, for a linked draft that gained a line adding
a unit, its Agreement's `agreement_usage_`, so `replacement_case` comes before `agreement_usage`.
The daily refresh run never takes it, and nothing under it takes `refresh_orders`. A press holds
it for one raise, far short of `ABANDONED_AFTER_MINUTES`, so it does not check for a lost lock.
The Asset rule that takes a unit lost in transit off its Order line takes no lock: it queues the
Order's sourcing rather than take `source_order_<Order sys_id>` inside an Asset save. The rack
re-check after an Asset's placement is saved takes `recon_exception_<type>_<rack sys_id>`. It holds
no lock of its own, and runs under `receive_asset_` only when a return receipt or overdue
declaration clears a placement, which the lock order allows.
`track_shipment_<Shipment sys_id>` is taken by the tracking webhook and its queued retry
(`x_daas_ham.shipment.track`) holding no other lock, and by *Mark label voided*: alone for a return
label, and under `ship_order_<Order sys_id>` for an outbound one. A void that finds `ship_order_`
held does not retry, like *Cancel order*: it changes nothing and asks the user to try again. Only
its inner `track_shipment_` take is tried `LOCK_TRIES` times back to back. Nothing takes another
lock while
holding `track_shipment_`: the Order's delivered note, its cleared tracking and the Return order's
voided note are written after it is released. So it must stay after `ship_order`.
The daily spare-pool top-up counts, fills and buys for each short Spare pool under
`spare_pool_<Customer sys_id>_<Model sys_id>`, so a run and an *Execute now* at once never both buy
for one shortfall. It holds no other lock when it takes it, tries `LOCK_TRIES` times back to back
and leaves a
pool held through them to the run holding it. Under it, it takes only the `reserve_asset_` lock of
each unit it moves (and what that unit's save takes under it), so it comes just before
`reserve_asset`.
The OEM claim run holds `oem_claim_run` for the whole run, so a run and an *Execute now* at
once never send a step to its vendor twice: that would spend two runs' calls in one rate-limit window,
and the second claim of a device already claimed fails, marking the step the first run ticked done
failed. It holds no other lock when it takes it, does not retry, and sends nothing when it finds it
held. Under it, it saves staging steps, whose rules take no lock. A run that outlasts it loads no
more due steps once it has lost it, so it calls no vendor after that, and it saves what its calls so
far returned. A step found done when a failure is saved is left done.
The OEM coverage run holds `oem_coverage_run` for the whole run, so a run and an *Execute
now* at once never load the same stalest Assets and both insert a serial's new contract: the copy
not updated afterwards would keep a stale coverage end. It holds no other lock when it takes it,
does not retry, and checks nothing when it finds it held. Under it, it saves coverage records and
Assets, and every lock their rules take comes later in the order. A run that has lost it starts no further batch.
The daily lease review holds `lease_review_run` for the whole run, so a run and an *Execute now* at
once never both find a lease with no open decision and raise one each: the second would stay open
once the first is applied, could be applied again, and would keep the review from raising the next.
It holds no other lock when it takes it, does not retry, and reviews nothing when it finds it held.
Under it, it saves Lease schedules and inserts decisions, whose rules take no lock. A run that has
lost it raises no further decision.
The daily attestation run holds `attestation_run` for the whole run, so a run and an *Execute now*
at once never both find a Site with no open attestation and open one each. It holds no other lock
when it takes it, does not retry, and opens nothing when it finds it held. Under it, it inserts
attestations and their items, whose rules take no lock. A run that has lost it opens no further
attestation.
The daily chase of overdue returns holds `overdue_returns_run` for the whole run, so a run and an
*Execute now* at once never both read a Return order as not escalated and notify its Customer
twice, nor both advance the job's cursors. It holds no other lock when it takes it, does not
retry, and chases nothing when it finds it held. Under it, it declares each unit missing under that
unit's `receive_asset_` lock, with what that takes under it, so it comes before `receive_asset`. A
run makes two passes under it: the chase, then the close of the Return orders no line keeps open,
which takes no other lock. Each pass ends on the job time budget
(`x_daas_ham.job.budget_seconds`), so a run takes at most twice that, well short of
`ABANDONED_AFTER_MINUTES` as shipped, and does not check for a lost lock.
A unit is put on a Return order under `return_asset_<Asset sys_id>`: the check that it awaits no other
return and the insert of its line are one critical section, so two Returns raised at once (a request
sent twice, the record producer beside the customer page or an Agreement's end) never both take it.
No unique index could hold that, as an Asset is on any number of settled lines. It is tried
`LOCK_TRIES` times
back to back; a unit held through them is left to the Return holding it, which takes it. Under it,
the unit's move to pending return is saved, with what that save takes (`service_interval_`). The
customer page raises a Customer's return requests under `return_request_<Customer sys_id>`, holding
no other lock, without retrying: a request that finds it held raises nothing and asks the user to try
again, and one whose devices all await a return already raises nothing either. So a request sent twice
raises one Return order, with one de-install work order and change. Under it, the Return order is
raised and each unit put on it under its `return_asset_` lock, so `return_request` comes just before
`return_asset`. Neither is taken under `reserve_asset`, nor takes it, so both come after it.
A fee is charged under `fee_<type>_<Asset sys_id>_<Return order sys_id>`, and a billing generation
bills it under the same lock: it reads the fee afresh there and adds its line and links it only
while it is open and on no other period, so a month generating beside a *Regenerate* of another
never bills one fee on both. The generation holds no other lock when it takes it, tries `LOCK_TRIES`
times
back to back, and counts a fee held through them as failed unless another period has it by then.
A waiver (a unit declared missing is scanned in at the depot) takes the same lock, under the unit's
`receive_asset_` lock, and reads the fee's open charges afresh there. A charge on no Billing period
is waived at once. For a charge on a period, the waiver takes that period's `billing_period_` lock
under the fee's, the only lock taken under a fee's, and waives the charge only while the period is
not closed. Each of the two takes is tried `LOCK_TRIES` times back to back. A charge whose lock or
whose period's lock is held through them, or whose period is closed, stays open and is logged as an
error, to waive by hand or to credit.
*Close period* and *Regenerate* of a Billing period run under `billing_period_<period sys_id>`,
holding no other lock, and each reads the period's status afresh there. So a Regenerate never
deletes the lines of a period Close is locking, and Close never locks a period a Regenerate has
emptied. Each tries `LOCK_TRIES` times back to back, and one that finds the lock held through them
changes
nothing and asks the user to try again. A fee's waiver takes the lock too, under the fee's lock
(above), so it lands wholly before a Close, which then takes the waived fee and its line off the
period, or after it, when it finds the period closed and leaves the fee as the Close billed it. A
waiver saved in the middle of a Close would otherwise stay on the closed bill (saved after the Close
took the waived fees off) or be overwritten as billed (saved while the Close marks the fees billed).
Nothing is taken under it.

An audit's scans and *Close audit* take turns under `audit_<audit sys_id>`, each holding no other
lock when it takes it, so a scan lands wholly before the close reads the lines, or finds the audit
closed when it reads it again under the lock and records nothing. Both try `LOCK_TRIES` times back
to back: a
scan held through them answers HTTP 503, to scan again, and a close changes nothing and asks the user
to close again. Under it, the close raises each *missing in audit* exception under its
`recon_exception_` lock, so `audit` comes just before `recon_exception`.

Whether the instance behaves as expected is on the first-install checklist.
