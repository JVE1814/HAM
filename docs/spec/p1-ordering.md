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
- Through the record producer, an Order its requester may not raise is removed again. One that names
  records not of its Customer stays a draft with its lines (except those of a Site template not offered
  to the Customer), to correct and submit.

## Entitlement (`domain/entitlement.ts`)

- A line is **catalogued** when its Model is a current Catalog entry of the Customer, or when it came
  from a Site template that is itself a current Catalog entry. Expired or inactive entries do not
  count.
- **Usage** = Assets of the Agreement at or on their way to a Site (shipped, pending in service, in
  service, temporary deployment, pending return) + quantities on other open, not-yet-shipped Order
  lines of the Agreement.
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
- Provider-side approvers are the Agreement's account manager or, if it has none, the asset managers.
  If the Customer has no Customer admins, the provider-side approvers stand in for them. If there is
  no approver at all, the Order gets a work note and someone must add an approver manually.
- A rejected Order cancels its lines, so they stop counting as usage. Usage also ignores draft and
  cancelled Orders.

## Sourcing (`domain/sourcing.ts`)

| Purpose | Priority |
|---|---|
| New install | Customer Spare pool → free central stock → purchase |
| Replacement (device replace) | hot spare in a customer-site stockroom of that Customer → Spare pool → free central stock → purchase |

- Another Customer's spares are never used. Picks are ordered by stockroom, then asset, for
  determinism.
- Reserved Assets take the Customer as `company` and the Agreement (ADR 0006); in-house stock at the
  staging centre moves to *staging* at once, with a Staging task.
- Stock already on an Order line is not picked: a hot spare linked to a line stays in the Spare pool but
  is taken.
- Two sourcing runs never claim the same Asset, whether reserving it or linking a hot spare: each claim
  is made under a lock on that Asset and re-checks that it is still free stock or spare-pool stock on no
  Order line. A run that finds it locked or taken leaves it, and that unit counts in the line's shortfall.
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
  Asset lock), and are installed from where they are.
- Shortfalls become one requested purchase order per line (ship to the staging centre); received units
  of that PO are allocated to the line on receipt.
- Without a staging stockroom (`x_daas_ham.staging.default_stockroom`) no purchase order is requested, and a
  line whose purchase order Procurement does not create, or creates without its line item (that PO is removed
  again, or named for cancelling), is treated the same way: the line waits for stock and its sourcing summary
  says why. The spare-pool top-up then buys nothing and logs a warning.
- Re-sourcing a line only covers `quantity − allocated − on order`.
- Several source stockrooms give several transfer orders, all listed on the line.
- A failed staging takes the Asset off the line, which goes back to awaiting stock and is re-sourced.
- **Cancel** is refused once anything has shipped (use a return order then). Otherwise it:
  - releases the stock: hot spares stay in the pool, other Assets return to free stock under the
    Provider company;
  - skips open staging tasks;
  - lists any purchase orders for cancelling in Procurement.

  A cancelled or rejected Order keeps its stage.

## Spare-pool top-up (daily)

For each active Agreement with a spare-pool ratio, and each Model it has deployed:
`shortfall = ceil(deployed × ratio) − reserved spares`. Free central stock is moved into the pool,
each unit claimed under the same Asset lock as sourcing and only while it is still available on no Order
line: a unit sourcing took in the meantime, or whose save is refused, is not moved and stays in the
shortfall. If `x_daas_ham.spare_pool.auto_purchase` is true, purchase orders are requested for
the rest, net of top-up purchases still open for that Agreement and Model.
