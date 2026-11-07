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
  keeps is logged, to cancel). One that names records not of its Customer stays a draft with its lines
  (except those of a Site template not offered to the Customer), to correct and submit. So does one
  missing a line the platform refused: the user is told, and its work notes say, how many order lines
  were not saved, to add them and submit.

## Entitlement (`domain/entitlement.ts`)

- A line is **catalogued** when its Model is a current Catalog entry of the Customer, or when it came
  from a Site template that is itself a current Catalog entry. Expired or inactive entries do not
  count.
- **Usage** = Assets of the Agreement at or on their way to a Site (shipped, pending in service, in
  service, temporary deployment, pending return) + quantities on other open, not-yet-shipped Order
  lines of the Agreement. A line that has shipped never counts as open again, also when one of its
  Assets is later returned. An Asset still on an open Order line counts through that line's quantity,
  not as deployed, so a unit sent by a partial Ship counts once; Assets on no line, or on a line that
  has shipped or was cancelled, count as deployed.
- A Contracted quantity caps either one Model (model-specific) or a Device class. Classes without a
  quantity are uncapped.
- Verdict: **over quota** if any cap would be exceeded, else **off catalog** if anything is not
  catalogued, else **within agreement**. All findings are recorded on the Order.

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
  (logged), and a later decision on them tries again; with none left it stays there until cancelled.
  A pending request that cannot be cancelled is logged, to cancel by hand; left waiting, it would
  still count if a draft is submitted again.
- Provider-side approvers are the Agreement's account manager or, if it has none, the asset managers.
  They are active users only: an inactive account manager counts as none, so the asset managers
  approve. If the Customer has no Customer admins, the provider-side approvers stand in for them.
- If there is no approver, or the requests the platform saved could not approve it, the saved
  requests are cancelled again and the Order stays a draft; the user is told why and it goes in its
  work notes. An Order the platform will not save as approved (within agreement) or awaiting approval
  also stays a draft, and the user is told why; requests already made are cancelled again.
- A rejected Order cancels its lines, so they stop counting as usage. It is saved as rejected first,
  so one the platform refuses keeps its lines. Usage also ignores draft and cancelled Orders. Units a
  cancelled line had already shipped count as deployed again, since cancelling closes the line.

## Sourcing (`domain/sourcing.ts`)

| Purpose | Priority |
|---|---|
| New install | Customer Spare pool → free central stock → purchase |
| Replacement (device replace) | hot spare in a customer-site stockroom of that Customer at the Order's Site (the stockroom's location is the Site or one of its Rooms) → Spare pool → free central stock → purchase |

- A hot spare at another of the Customer's Sites is not used; a customer-site stockroom needs its
  location set.
- Another Customer's spares are never used. Stock is looked up one source at a time (site hot
  spares, the Customer's Spare pool, free stock), filtered to the Customer in the query and read by
  stockroom then sys_id, so other Customers' spares never crowd out usable stock and the picks are the
  same on every run.
- Free central stock is available stock outside customer-site stockrooms; a stockroom with no type,
  or an Asset in none, counts as a central depot.
- Reserved Assets take the Customer as `company` and the Agreement (ADR 0006); in-house stock at the
  staging centre moves to *staging* at once, with a Staging task.
- Stock already on an Order line is not picked: a hot spare linked to a line stays in the Spare pool but
  is taken.
- Stock of a lease being returned to its Lessor (end action *Return to lessor*) is never picked or
  claimed, wherever it sits.
- Two sourcing runs, or a run and a receipt reserving its unit for the waiting line, never claim the
  same Asset, whether reserving it or linking a hot spare: each claim is made under a lock on that
  Asset (`reserve_asset_<sys_id>`) and re-checks that it is still free stock or spare-pool stock on no
  Order line and not on a lease being returned. A run that finds it locked or taken leaves it, and
  that unit counts in the line's shortfall. Put-away (P1 fulfilment spec) and a lease return's
  withdrawal (P3 contracts spec) take the same lock, so neither can move a unit a claim is taking.
  The lock may also be held by one of them, so a pass can leave out a unit that is still free.
- A claim that outlasts its lock (cleared as abandoned, ADR 0013) saves only while it still holds the
  lock. One that lost the lock during its save keeps the Asset only if a fresh read still shows it on the
  line. Otherwise it gives the Asset up with a warning, and the unit counts in the shortfall.
- Stock outside the staging centre is reserved and gets a transfer order to it, and only then its
  Staging task and the move to *staging*. If Inventory does not create the transfer order or all its
  lines, what was created is removed (or named in the summary for cancelling) and the stock is put back:
  Spare-pool stock to the pool, the rest to free stock. That stock is not bought: the line waits for
  stock, its sourcing summary says why, and it picks the stock again when next sourced.
- If the Staging task cannot be created, the Asset stays reserved for the line (a warning is logged) and
  is not moved to *staging*.
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
- Re-sourcing a line only covers `quantity − allocated − on order − open OEM RMAs`, where on order
  is units bought and not yet received. These figures are read together under the line's lock
  (below), so a receipt for the line is counted whole or not at all.
- An Order's sourcing passes take turns under a job lock on the Order (`source_order_<sys_id>`, ADR
  0013), so two passes never count the same shortfall. **Cancel** holds it too (below). A pass that
  finds it held, by another pass or a cancel, runs again about a minute later, up to 15 times, then
  is dropped with a warning.
- A line's need is counted under a job lock on the line (`order_line_<sys_id>`), which a receipt for
  the line takes too. The stock pick runs outside that lock, each claim under its Asset's lock. The
  pass then buys and saves the line under its lock again. There the line is counted again and the
  pass buys only what is still missing: what its first count left to buy, less any need met since
  (for example a unit received for the line with nothing left on order to take off). The line's
  summary then notes *<n> not bought: met since the line was counted*. Stock it put back for want of
  a transfer order is still not bought. A need that grew meanwhile is left to a later pass, which
  picks stock before it buys. Stock the pass claimed beyond a need lowered meanwhile stays on the
  line (rare: a unit received for the line with nothing left on order to take off). What the pass
  bought is added to the *On order* count as it then stands, and its transfer and purchase orders
  are added to the line's lists as they then stand.
- A line whose lock stays held through 10 tries, or a pass that lost the Order's lock (ADR 0013), is
  left to the pass queued again. A warning names any transfer orders the line does not list, to add
  by hand.
- Several source stockrooms give several transfer orders, all listed on the line.
- If the line cannot be saved after sourcing, a warning names the purchase order and transfer orders
  it does not list, to add by hand: otherwise units received on them are not allocated to it, and the
  next run buys its shortfall again.
- A failed staging takes the Asset off the line, which goes back to awaiting stock and is re-sourced.
  Only a line that has not shipped falls back. A receipt whose unit could not be reserved for its
  waiting line also sources the Order again (P1 fulfilment spec).
- **Cancel** is refused once anything has shipped, a hot spare handed over at Ship included (use a
  return order then), and does nothing when the form's save is refused (the platform says why). It
  runs under the Order's sourcing lock (`source_order_<sys_id>`), taking turns with sourcing passes: pressed while a pass holds it, it changes nothing and says *Order not
  cancelled: sourcing is running on it. Try again in a minute*. Otherwise it:
  - saves the Order as cancelled first, listing every purchase order of its lines in its work notes
    for cancelling in Procurement (if the platform refuses, the user is told and nothing is
    released);
  - releases the stock: hot spares stay in the pool, other Assets return to free stock under the
    Provider company;
  - skips open staging tasks;
  - cancels the Order's pending approvals.

  A line, unit or staging task the platform refuses to cancel or release is logged and the user is
  told. A rejected Order's lines are cancelled the same way. A cancelled, rejected or complete Order
  keeps its stage.

  Sourcing reads each line and its Order again under the line's lock, before it picks stock and again
  before it buys and saves. It leaves a line that is no longer open, or whose Order is cancelled or
  rejected: a rejected Order's lines are cancelled without the sourcing lock, and a line whose cancel
  was refused stays open. For a line that closed while the pass picked stock for it, nothing is bought
  or saved, and the warning *<line> closed while it was sourced: nothing bought for it* names the
  units still on it to release and the transfer orders to cancel. A cancel that outlasted its lock
  (ADR 0013) logs *<Order> cancelled after its sourcing lock was lost*, to check its lines for stock
  reserved or bought meanwhile.

## Spare-pool top-up (daily)

For each active Agreement with a spare-pool ratio, and each Model it has deployed:
`shortfall = ceil(deployed × ratio) − reserved spares`. Reserved spares are the Customer's spare-pool
units, leaving out units on a lease being returned to its Lessor: sourcing can no longer claim them,
so the top-up replaces them (`domain/sourcing.ts` `reservedSparesQuery`). Free central stock is moved
into the pool, each unit claimed under the same Asset lock as sourcing and only while it is still
available on no Order line and not on a lease being returned: a unit sourcing took in the meantime, or
whose save is refused, is not moved and stays in the shortfall. If `x_daas_ham.spare_pool.auto_purchase`
is true, purchase orders are requested for the rest, net of top-up purchases still open for that
Agreement and Model.
