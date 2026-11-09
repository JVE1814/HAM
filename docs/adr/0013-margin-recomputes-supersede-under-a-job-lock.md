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
row. A chunk that finds the lock held writes nothing and runs again a minute later from the same
pass and cursor, so nothing is lost or written twice; that holds because a superseding job's `handle`
only accumulates in memory and every write happens under the lock. A lock held for over ten minutes is
taken as abandoned (its holder's transaction died) and cleared by the next taker, so a crash delays
recomputes instead of stalling them. A holder that is in fact still running is not stopped, and what it
writes then sits beside the pass that took over. So after each write under the lock (the start, each
flush and the completion), and when one throws, the holder checks that it still holds the lock. One
that lost it writes nothing more, throws nothing, logs *job lock lost while writing* and at once queues
another fresh pass, which supersedes the one that took over, clears the period and recomputes it. Until
that pass completes, the Margin can be wrong (the pass that took over may complete first and count the
lost holder's Cost facts), and a write that keeps outlasting the ten minutes restarts the recompute
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
it held is queued again about a minute later, at most 15 times, because a purchase already requested
cannot be cleared the way a recompute clears its period. *Cancel order* takes the same lock, so a
cancel and a pass take turns; a cancel that finds it held changes nothing and asks the user to try
again. Under it, *Cancel order* also takes the Order's Ship lock (`ship_order_<Order sys_id>`), so a
Ship cannot run between its shipped check and its release of the lines; one that finds it held
changes nothing and says a Ship of the Order is running, without retrying. It is the only holder of
both, and Ship never takes `source_order_`, so `source_order` stays before `ship_order`. The daily
refresh run holds `refresh_orders`, a lock of the same kind, and, like *Cancel order*, does not
retry: a run that finds its lock held raises nothing and leaves it to the run holding it. Short
critical sections, such as an Order line, an ASN row's serial, the Provider tag counter, a stock
change, a Service interval, a Subscription line's start, a sighting or a tracking update, take locks
of the same kind and, finding one held, try again back to back a few times (`withLockTries` in
`platform/locks.ts`) before they give up. A tracking update that gives up is not left to the
aggregator (ShipEngine resends it at most twice, typically 30 minutes apart, then drops it): it is
queued as an event that tries the lock again, then a minute apart, at most 15 more times.

Locks are not re-entrant: a holder that takes a lock it already holds is refused, as any other taker
would be. A take never waits either: it tries and gives up. So locks are taken in one order, and a
holder only takes locks later in it than those it holds:

`refresh_orders` < `seen_asset` < `receive_serial` < `receive_asset` < `source_order` <
`ship_order` < `track_shipment` < `return_label` < `order_line` < `provider_tag_sequence` <
`spare_pool` < `reserve_asset` < `fee` < `recon_exception` < `subscription_line` <
`service_interval` < job locks (the margin recompute's).

Only the device-events REST handler and the in-service detection job take `seen_asset_<sys_id>`, and
they hold no other lock when they do. The go-live under it starts its pending Subscription line
under `subscription_line_<line sys_id>` and releases it before the go-live save takes
`service_interval_<sys_id>`. Nothing takes `subscription_line_` except that go-live, and nothing is
taken under it. `refresh_orders` is held by the daily refresh run for the whole run, and the run
holds no other lock when it takes it. The Orders it raises are inserted and submitted under it,
which takes no lock today (sourcing runs from the queued event), so nothing is taken under it. It
comes first all the same, ahead of anything a submit might come to take.
The Asset rule that takes a unit lost in transit off its Order line takes no lock: it queues the
Order's sourcing rather than take `source_order_<Order sys_id>` inside an Asset save. The rack
re-check after an Asset's placement is saved takes `recon_exception_<type>_<rack sys_id>`. It holds
no lock of its own, and runs under `receive_asset_` only when a return receipt or overdue
declaration clears a placement, which the lock order allows.
`track_shipment_<Shipment sys_id>` is taken by the tracking webhook and its queued retry
(`x_daas_ham.shipment.track`) holding no other lock, and by *Mark label voided*: alone for a return
label, and under `ship_order_<Order sys_id>` for an outbound one. A void that finds `ship_order_`
held does not retry, like *Cancel order*: it changes nothing and asks the user to try again. Only
its inner `track_shipment_` take is tried 5 times back to back. Nothing takes another lock while
holding `track_shipment_`: the Order's delivered note, its cleared tracking and the Return order's
voided note are written after it is released. So it must stay after `ship_order`.
The daily spare-pool top-up counts, fills and buys for each short Spare pool under
`spare_pool_<Customer sys_id>_<Model sys_id>`, so a run and an *Execute now* at once never both buy
for one shortfall. It holds no other lock when it takes it, tries 5 times back to back and leaves a
pool held through them to the run holding it. Under it, it takes only the `reserve_asset_` lock of
each unit it moves (and what that unit's save takes under it), so it comes just before
`reserve_asset`.

Whether the instance behaves as expected is on the first-install checklist.
