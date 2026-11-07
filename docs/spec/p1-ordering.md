# Ordering, entitlement and approvals (P1.3–P1.4)

## Raising an Order

- Entry point: the record producer **Request network equipment** (service desk on the Customer's
  behalf in P1; the CSM portal in P2), or a draft Order created in the workspace and submitted with
  **Submit**.
- An Order has a Customer, Agreement, Site, order type (site rollout, device add, device replace,
  temporary deployment) and Install mode.
- Lines come from the chosen Site template (its non-optional items, flagged *from site template*)
  plus any individual device rows.

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
- Reserved Assets take the Customer as `company` and the Agreement (ADR 0006); in-house stock moves to
  *staging* with a Staging task. Stock outside the staging centre gets a transfer order to it.
- Hot spares at the site stay in the Spare pool, linked to the line, and are installed from where
  they are.
- Shortfalls become one requested purchase order per line (ship to the staging centre); received units
  of that PO are allocated to the line on receipt.
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
`shortfall = ceil(deployed × ratio) − reserved spares`. Free central stock is moved into the pool. If
`x_daas_ham.spare_pool.auto_purchase` is true, purchase orders are requested for
the rest, net of top-up purchases still open for that Agreement and Model.
