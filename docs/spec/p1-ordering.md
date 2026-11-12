# Ordering, entitlement and approvals (P1.3–P1.4)

## Raising an Order

- Entry point: the record producer **Request network equipment** (service desk on the Customer's
  behalf in P1; the CSM portal in P2), or a draft Order created in the workspace and submitted with
  **Submit**.
- An Order has a Customer, Agreement, Site, order type (site rollout, device add, device replace,
  temporary deployment) and Install mode.
- Lines come from the chosen Site template (its non-optional items, flagged *from site template*)
  plus any individual device rows.
- Only Order raisers raise Orders (the Order create rule: asset managers, account managers, NOC, the
  service desk and Customer admins); site contacts never do. A Customer admin orders only for their
  own Customer.
- The Agreement must be the Customer's, the Site one of the Customer's Sites, and the Site template the
  Customer's own or one offered to every Customer. **Submit** checks both rules every time, break-fix
  and refresh Orders included: otherwise the Order stays a draft, the user is told why and the reasons
  go in its work notes.
- **Submit** on the Order form does nothing when the form's save is refused (the platform says why):
  it assesses nothing, asks no approvers and starts no sourcing from values the form did not save.
- Through the record producer, an Order its requester may not raise is removed again (one the platform
  keeps is logged, to cancel). Its answers to the producer's questions stay on the instance: the
  platform's `question_answer` table lets no application delete from it. One that names records not
  of its Customer stays a draft with its lines (except those of a Site template not offered to the
  Customer), to correct and submit. So does one
  missing a line the platform refused: the user is told, and its work notes say, how many order lines
  were not saved, to add them and submit.
- A Customer contact's Order is checked before it is saved, whatever inserts it: one that fails the
  ownership rule above is refused with *Order not raised* and the reasons, and nothing is stored
  (`platform/orders.ts` `contactOrderInsertRefusal`). A contact's insert by hand (a form, the Table
  API) keeps no posted value, as they are an external user, and fails the Order create rule; the
  check guards the record producer and any other insert that keeps the values. The record producer
  runs it in its own script, before the insert (`entry/orders.ts` `beforeOrderProduced`): refused
  there, the request stores none of its answers, which a refusal by the before-insert rule would
  leave on the instance. So an Order that names records not of its Customer stays a draft only when
  provider staff or the service desk raised it.

## Entitlement (`domain/entitlement.ts`)

- A line is **catalogued** when its Model is a current Catalog entry of the Customer, or when it came
  from a Site template that is itself a current Catalog entry. Expired or inactive entries do not
  count.
- **Usage** = Assets of the Agreement at or on their way to a Site (shipped, pending in service, in
  service, temporary deployment, pending return) + quantities on other open, not-yet-shipped Order
  lines of the Agreement. A line that has shipped never counts as open again, also when one of its
  Assets is later returned. The exception is a line filled again after a unit left it in transit (P1
  fulfilment spec): back to awaiting stock, it counts its whole quantity in flight again until it
  ships, and the unit sent back counts as deployed until it is received. An Asset still on an open
  Order line counts through that line's quantity, not as deployed, so a unit sent by a partial Ship
  counts once; Assets on no line, or on a line that has shipped or was cancelled, count as deployed.
- A Contracted quantity caps either one Model (model-specific) or a Device class. Classes without a
  quantity are uncapped.
- Verdict: **over quota** if any cap would be exceeded, else **off catalog** if anything is not
  catalogued, else **within agreement**. All findings are recorded on the Order.
- Submissions of one Agreement take turns under the job lock `LOCK.agreementUsage` in
  `domain/lock-names.ts`
  (ADR 0013): each reads the Order, its lines and the Agreement's quantities and usage afresh,
  assesses it and saves it out of draft before the next reads, so two Orders submitted at once never
  both fit a quantity only one fits. Only an Order with a line that adds a unit takes it: one whose
  lines all replace Assets (break-fix, refresh) reads no usage. A submission goes on only from
  draft: one that finds the Order already submitted says *Order <number> was already submitted* and
  counts as gone ahead (a second *Raise replacement* says it is raised); one whose Customer or
  Agreement changed meanwhile, or that gained a line adding a unit, stays a draft, to submit again.
- Every submission, with or without that lock, holds the Order's sourcing lock
  (`LOCK.sourceOrder`, as **Cancel** below) from its read of the draft through its save out of
  draft, so a cancel never lands between them. One that finds it held through `LONG_HOLD_LOCK_TRIES`
  tries (`domain/job-lock.ts`) stays a draft
  and says *Order not submitted: it is being cancelled. Try again shortly*.
- A submission that finds the lock held through `LONG_HOLD_LOCK_TRIES` tries leaves the Order a
  draft, its work notes
  saying why, and it is submitted again automatically `REQUEUE.delaySeconds` seconds later, at most
  `REQUEUE.times` times, then left
  for staff to submit (logged). *Submit* says *Order not submitted yet: another Order of its
  Agreement was being submitted at the same time. It is submitted again automatically in a minute*.
  Through the record producer, whose requester may have no *Submit*, it says *Order <number> is
  saved and is submitted within a few minutes: another order of the same agreement was being
  submitted at that moment. There is no need to raise it again*.
- The lock orders submissions only. A line added to an Order already submitted, a quantity or
  Agreement changed on one, or an Asset adopted into the Agreement changes its usage unassessed.

## Approvals (`domain/approvals.ts`, ADR 0004)

| Verdict | Approvers |
|---|---|
| within agreement | none: the Order is approved and sourcing starts |
| off catalog | any Customer admin of the Customer |
| over quota | any Customer admin **and** the Agreement's account manager |

- Approvals are `sysapproval_approver` records; a rule rolls them up: any rejection rejects the
  Order; it is approved once each required group has an approval. Remaining requests are cancelled.
  The Order's outcome is saved before they are, so cancelling them does not roll the approvals up
  again or start sourcing twice.
- If that outcome cannot be saved, the Order stays awaiting approval with its remaining requests
  (logged), and a later decision on them tries again; with none left it stays there until cancelled
  or re-checked. *Re-check approvals* (asset managers, account managers, admins) rolls the existing
  approvals up again, as a decision does, or says whose approval is missing. It is offered on an
  Order awaiting approval only while no request is still waiting, so with several approvers a refused
  save waits for a remaining decision, or for its requests to be cancelled by hand. Like Submit, it
  does nothing when the form's save is refused. A pending request that cannot be cancelled is
  logged, to cancel by hand; left waiting, it would still count if a draft is submitted again.
- Provider-side approvers are the Agreement's account manager or, if it has none, the asset managers.
  They are active users only: an inactive account manager counts as none, so the asset managers
  approve. If the Customer has no Customer admins, the provider-side approvers stand in for them.
  Who decides for which group is fixed when the Order is put to approval: the Order keeps the
  Customer admins it asked (*Customer admins asked*). An admin onboarded meanwhile is not asked, and
  the provider-side approvers still decide for both groups; an admin whose role is removed meanwhile
  still decides for the Customer admins only.
- If there is no approver, or the requests the platform saved could not approve it, the saved
  requests are cancelled again and the Order stays a draft; the user is told why and it goes in its
  work notes. An Order the platform will not save as approved (within agreement) or awaiting approval
  also stays a draft, and the user is told why; requests already made are cancelled again.
- A rejected Order cancels its lines, so they stop counting as usage. It is saved as rejected first,
  so one the platform refuses keeps its lines. Both are done holding each open line's lock
  (`LOCK.orderLine`, as **Cancel** below): a rejection that finds one held changes nothing, is
  logged and leaves the Order awaiting approval, and *Re-check approvals* says *Order not saved as
  rejected: one of its lines is being received or cancelled*. Usage also ignores draft and cancelled
  Orders. Units a cancelled line had already shipped count as deployed again, since cancelling closes
  the line.

## Sourcing (`domain/sourcing.ts`)

| Purpose | Priority (`PRIORITY`) |
|---|---|
| New install | Customer Spare pool → free central stock → purchase |
| Replacement (device replace) | hot spare in a customer-site stockroom of that Customer at the Order's Site (the stockroom's location is the Site or one of its Rooms) → Spare pool → free central stock → purchase |

- A hot spare at another of the Customer's Sites is not used; a customer-site stockroom needs its
  location set.
- Another Customer's spares are never used. Stock is looked up one source at a time (site hot
  spares, the Customer's Spare pool, free stock), filtered to the Customer in the query and read by
  stockroom then sys_id, so other Customers' spares never crowd out usable stock and the picks are the
  same on every run.
- Only Fleet assets are sourced (ADR 0016). Free central stock is available stock in a central depot
  or a staging centre. A stockroom with no type is not a NaaS stockroom, so stock there, or in no
  stockroom, is never picked.
- Reserved Assets take the Customer as `company` and the Agreement (ADR 0006); in-house stock at the
  staging centre moves to *staging* at once, with a Staging task.
- Stock already on an Order line is not picked: a hot spare linked to a line stays in the Spare pool but
  is taken.
- Stock of a lease being returned to its Lessor (end action *Return to lessor*) is never picked or
  claimed, wherever it sits.
- Two sourcing runs, or a run and a receipt reserving its unit for the waiting line, never claim the
  same Asset, whether reserving it or linking a hot spare: each claim is made under a lock on that
  Asset (`LOCK.reserveAsset`) and re-checks that it is still free stock or spare-pool stock on no
  Order line and not on a lease being returned. A run that finds it locked or taken leaves it, and
  that unit counts in the line's shortfall. Put-away (P1 fulfilment spec) and a lease return's
  withdrawal (P3 contracts spec) take the same lock, so neither can move a unit a claim is taking.
  The lock may also be held by one of them, so a pass can leave out a unit that is still free.
- A claim that outlasts its lock (cleared as abandoned, ADR 0013) saves only while it still holds the
  lock. One that lost the lock during its save keeps the Asset only if a fresh read still shows it on the
  line. Otherwise it gives the Asset up with a warning, and the unit counts in the shortfall.
- Stock outside the staging centre is reserved and gets a transfer order to it (P1 fulfilment spec,
  In transfer). Inventory takes onto a line only an Asset *In stock / Available*, so each unit is
  saved available, still on its Order line and claimed by nobody else, just before its line is
  inserted, and Inventory then puts it *in transfer*. Its Staging task is opened at once, and the
  unit goes into *staging* when Inventory receives the line at the staging centre (in the stockroom
  Inventory sets); the task cannot be closed before then (P1 fulfilment spec, Staging). Meanwhile the
  line counts it as sourced. If Inventory cancels or deletes the line
  instead, the transfer has fallen through: the unit, reserved for the line again where it was, is
  put back as free stock, its Staging task is skipped, and the line goes back to awaiting stock and
  is sourced again (P1 fulfilment spec, In transfer), with a warning.
- If Inventory does not create the transfer order or all its lines, or a unit cannot be saved
  available for it, what was created is removed (or named in the summary for cancelling) and the
  stock is put back, read again as Inventory left it: Spare-pool stock to the pool, the rest to free
  stock. Inventory lets go each unit whose line is removed, reserved for the line again; sourcing
  marks those units while it removes the lines, so that is not taken for a transfer fallen
  through. That stock is not bought: the line waits for stock, its sourcing summary says why, and it
  picks the stock again when next sourced.
- If the Staging task cannot be created, the Asset stays reserved for the line (a warning is logged) and
  is not moved to *staging*; a unit in transfer then stays reserved for the line once received.
- Hot spares at the site stay in the Spare pool, linked to the line (claimed the same way, under the
  Asset lock), until Ship hands them over where they are (shipped, with no package).
- Each sourcing run with a shortfall requests one purchase order for the line (ship to the staging
  centre). The line lists every one (*Purchase orders*; *Latest purchase order* is the newest), and
  both are shown on the Order line form and in the workspace list *Lines awaiting stock*. A unit
  received on any of them is allocated to the line and comes off its *On order* count.
- Without a staging stockroom (`x_daas_ham.staging.default_stockroom`) no purchase order is requested, and a
  line whose purchase order Procurement does not create, or creates without its line item (that PO is removed
  again, or named for cancelling), is treated the same way: the line waits for stock and its sourcing summary
  says why. The spare-pool top-up then buys nothing and logs a warning.
- Re-sourcing a line only covers `quantity − allocated − on order − OEM RMAs`, where on order is
  units bought and not yet received, and the OEM RMAs are those whose replacement is still to come
  (*to open*, *open*). These figures are read together under the line's lock (below), so a receipt
  for the line is counted whole or not at all.
- An Order's sourcing passes take turns under a job lock on the Order (`LOCK.sourceOrder`, ADR
  0013), so two passes never count the same shortfall. **Cancel** holds it too (below). A pass that
  finds it held, by another pass or a cancel, runs again `REQUEUE.delaySeconds` seconds later, at
  most `REQUEUE.times` times, then
  is dropped with a warning.
- A line's need is counted under a job lock on the line (`LOCK.orderLine`), which a receipt for
  the line, **Cancel** and a rejection take too. The stock pick runs outside that lock, each claim under its Asset's lock. The
  pass then buys and saves the line under its lock again. There the line is counted again and the
  pass buys only what is still missing: what its first count left to buy, less any need met since
  (for example a unit received for the line with nothing left on order to take off). The line's
  summary then notes *<n> not bought: met since the line was counted*. Stock it put back for want of
  a transfer order is still not bought. A need that grew meanwhile is left to a later pass, which
  picks stock before it buys. Stock the pass claimed beyond a need lowered meanwhile stays on the
  line (rare: a unit received for the line with nothing left on order to take off). What the pass
  bought is added to the *On order* count as it then stands, and its transfer and purchase orders
  are added to the line's lists as they then stand.
- A line whose lock stays held through `LONG_HOLD_LOCK_TRIES` tries, or a pass that lost the Order's
  lock (ADR 0013), is
  left to the pass queued again. A warning names any transfer orders the line does not list, to add
  by hand.
- Several source stockrooms give several transfer orders, all listed on the line.
- If the line cannot be saved after sourcing, a warning names the purchase order and transfer orders
  it does not list, to add by hand: otherwise units received on them are not allocated to it, and the
  next run buys its shortfall again.
- A failed staging takes the Asset off the line, which goes back to awaiting stock and is re-sourced,
  and so does a unit that leaves in transit (P1 fulfilment spec). Only a line that has not shipped
  falls back on a failed staging. A receipt whose unit could not be reserved for its waiting line
  also sources the Order again (P1 fulfilment spec).
- **Cancel** is refused once anything has shipped: a line shipped or later, or any unit of its lines
  shipped or later (a hot spare handed over at Ship included), also on a line not delivered whole.
  The user is told to use a Return order instead. A unit taken off its line in transit no longer
  counts. Cancel does nothing when the form's save is refused (the platform says why). It runs
  under the Order's sourcing lock (`LOCK.sourceOrder`), taking turns with sourcing passes and
  submissions: pressed while one holds it, it changes nothing and says *Order not cancelled: it is
  being submitted or sourced. Try again in a minute*. Under it, it also takes the Order's Ship lock
  (`LOCK.shipOrder`), so no Ship sends units between its shipped check and its release of the
  lines: pressed while a Ship (or *Mark label voided* on one of the Order's outbound labels) holds
  it, it changes nothing and says *Order not cancelled: a Ship of the Order is running. Try again
  once it is done*. Under that, it takes the lock of each line not shipped (`LOCK.orderLine`,
  in sys_id order, `LONG_HOLD_LOCK_TRIES` tries each), which a receipt holds while it gives its unit
  to the line and
  stages it (P1 fulfilment spec): so no unit is given to a line between the cancel's release of its
  units and its cancel. Pressed while a receipt (or a rejection) holds one, it changes nothing and
  says *Order not cancelled: a unit is being received for one of its lines. Try again shortly*.
  Otherwise it:
  - saves the Order as cancelled first, listing every purchase order of its lines in its work notes
    for cancelling in Procurement (if the platform refuses, the user is told and nothing is
    released);
  - releases the stock of each line it locked, whatever stage the line now shows: hot spares stay in
    the pool, other Assets return to free stock under the Provider company; a unit in transfer
    leaves its line but stays in transfer, and is free stock once Inventory lets it go (P1
    fulfilment spec, In transfer). A line added to the Order meanwhile is new and is cancelled with
    the rest;
  - skips open staging tasks;
  - cancels the Order's pending approvals.

  A line, unit or staging task the platform refuses to cancel or release is logged and the user is
  told. A rejected Order's lines are cancelled the same way. A cancelled, rejected or complete Order
  keeps its stage: an Order stage derived from its lines and saved just after a cancel is saved
  cancelled again.

  Sourcing reads each line and its Order again under the line's lock, before it picks stock and again
  before it buys and saves. It leaves a line that is no longer open, or whose Order is cancelled or
  rejected: a rejected Order's lines are cancelled without the sourcing lock, and a line whose cancel
  was refused stays open. For a line that closed while the pass picked stock for it, nothing is bought
  or saved, and a warning (`platform/sourcing.ts`) names the
  units still on it to release and the transfer orders to cancel. A cancel that outlasted its lock
  (ADR 0013) logs which lock it lost. For the sourcing lock, check its
  lines for stock reserved or bought meanwhile. For the Ship lock, check for units shipped meanwhile.
  For a line's lock, check the lines for units received meanwhile. A receipt reads the line and its
  Order
  again under the line's lock and gives its unit only to a line awaiting stock on an Order neither
  cancelled nor rejected (P1 fulfilment spec). A line's stage derived from its Assets is never saved
  on a cancelled line or one whose Order ended, and a line whose Order ended while its stage was
  saved is cancelled again, so nothing reopens a line its Order's cancel or rejection closed.

## Spare-pool top-up (daily)

A Customer has one Spare pool per Model (owner decision), sized from all their deployed fleet units
of that Model across their active Agreements with a spare-pool ratio, each Agreement's ratio applied
to its own units and the sum rounded up once: `size = ceil(Σ deployed × ratio)` and
`shortfall = size − reserved spares` (`domain/spare-pools.ts` `sparePools`). Units on an Agreement
without a ratio, or not active, add nothing to the pool. The daily pass runs over those Agreements;
each Customer's pools are topped up once, from the row of their first Agreement by sys_id
(`sparePoolLead`), and their other Agreements' rows are passed over.

Reserved spares are counted per Customer and Model (`reservedSparesQuery`): the Customer's fleet
units in the pool, and the Customer's spares in transfer on no Order line, such as a spare on a
transfer order line between two stockrooms. Inventory gives such a unit back to the pool when it lets
it go, received or not (`domain/lifecycle.ts` `stageAfterTransfer`, ADR 0002), so it is still a spare
and is not replaced meanwhile. A unit in transfer on an Order line is sourcing's, on its way to
staging for that line, and is no spare. Units on a lease being returned to its Lessor are left out:
sourcing can no longer claim them, so the top-up replaces them.

Free central stock is moved into the pool, each unit claimed under the same Asset lock as sourcing
and only while it is still available on no Order line and not on a lease being returned: a unit
sourcing took in the meantime, or whose save is refused, is not moved and stays in the shortfall. A
spare moved in carries the Agreement with the largest share of the pool (the first by sys_id on a
tie); sourcing gives it its line's Agreement when it is used. A pool is counted again, filled and
bought for under its lock `LOCK.sparePool` (ADR 0013). If
`x_daas_ham.spare_pool.auto_purchase` is true, purchase orders are requested for the rest, net of
top-up purchases still open for that Customer and Model (found by the description
`requestSparePurchase` gives them, `platform/procurement.ts`).
