# Leases and renewals (P3.23–P3.24)

## Lease schedules (D65)

- A **Lease schedule** extends `ast_contract`: Lessor, schedule number, monthly payment (all its
  Assets), buyout price, end date, and how many days ahead the decision is due (default 120).
- A fleet asset is covered by setting its *Lease schedule*, while it is not retired. Its Legal owner
  becomes *lessor* and its Lessor the schedule's Lessor. A unit returned to the Lessor or the OEM (or
  disposed of) keeps its Lease schedule as history, but is no longer counted (*Covered assets* on the
  decision, *Assets covered at buyout*, Margin's lease share), transferred by a buyout or re-queued
  by the daily review.
- Leases are over fleet assets only (ADR 0016). A unit of the Provider IT's given a Lease schedule
  keeps its Legal owner and Lessor, and is neither counted, flagged for a mismatch, bought out,
  returned to the Lessor, given a Refresh due date nor warned about for its coverage. When such a
  unit joins the fleet (*Add to fleet*, or a warehouse receipt of a unit awaiting receipt) with its
  Lease schedule already set, its Legal owner becomes *lessor* and its Lessor the schedule's Lessor
  in the save that adds it, as if the schedule had just been set.
- **Mismatch** (daily): a lease whose Assets serve Customers (shipped, pending in service, in
  service, temporary) under an Agreement that ends after the lease, or has no end date, is flagged
  and the asset managers are emailed once. If the flag cannot be saved, it is logged and the alert
  goes again the next day.
- **End-of-lease decision** (daily): within the lead time of the end date, one decision task is
  raised (assigned to `x_daas_ham.leases.decision_group`) with the counts of covered and deployed
  Assets and the mismatch flag.

## Applying a decision

A lease takes one buy out or return: once its end action is *Buy out* or *Return to lessor*, applying
another decision is refused (an extension leaves it undecided, so a later decision is allowed). Apply
closes the decision before it changes the lease. If the platform refuses that save, nothing is
applied. If the lease then cannot be saved, nothing is applied and the decision is reopened. If the
reopen is refused too, it stays closed (logged) and the daily review raises a new decision for the
still-undecided lease (while the lease ended no more than 30 days ago). A closed decision is never
applied again, even from a form opened before it closed.

| Decision | Effect |
|---|---|
| Buy out | Every covered (not retired) Asset becomes Provider-owned and leaves the schedule, in a background job (chunked, so large leases do not time out the UI action); when a buyout price is recorded, each Asset's cost becomes its share of it and its purchase date the buyout day (its write-off starts then), fixed once on the lease (*Buyout cost per asset*, *Assets covered at buyout*) when the decision is applied. An Asset whose transfer the platform refuses is logged; the daily review queues the transfer again for a bought-out lease that still covers Assets (not retired) |
| Extend | The lease runs to the new end date (which must be later); a new decision comes due before it |
| Return | Stock (available, spare pool, not linked to an Order line) leaves circulation: each unit is read again first under its stock lock (`reserve_asset_<sys_id>`, the lock sourcing claims take) and moved only while it is still free stock on no Order line, so one reserved meanwhile keeps its reservation. It is moved to pending wipe (spare-pool stock through available, becoming Provider stock again) and only then put on a draft *return to lessor* disposal order; a unit whose move is refused, or whose lock stays held through 5 tries, stays off the order and is reported. A unit at pending wipe whose disposal line, or the disposal order itself, is refused is reported too and left on no disposal: add it by hand. A hot spare already linked to an Order line is left to it and swapped out once deployed. From the decision on, sourcing and the spare-pool top-up never claim the lease's units: they are left out of the stock queries and refused on the claim's fresh read. Nor does the top-up count them as reserved spares. Deployed Assets (including ones shipped or awaiting first sighting) get a Refresh due date no later than the lease end, so automatic refresh replaces them; the swapped-back units are returned and evaluated as usual. Whatever the outcome other than OEM RMA, a swapped-back unit of a returned lease goes to pending wipe, never back to stock, and it can only be returned to the lessor. Units of a returned lease that reach stock after the decision by another route (a released reservation, a unit put back from pending wipe) are not withdrawn automatically: move them to pending wipe and put them on a *return to lessor* disposal order by hand. If a returned lease's end date changes later, its deployed Assets' Refresh due dates are recomputed |

## Agreement currency

- Each **Agreement** bills in one currency: its *Currency*, a three-letter ISO 4217 code (e.g. EUR),
  mandatory and with no default. An Agreement saved before the field existed has none: set it before
  the next Billing period is generated, or that Agreement's lines and fees fail to bill (P3.25).
- The Agreement's Billing lines (its Subscription lines' and its Fee events') and its Cost facts are
  kept in that currency. A Subscription line's own *Currency* field is read-only and not used (it keeps
  the values saved before); nor is a Fee event's.
- Amounts of two currencies are never added: Billing period totals and Margin are kept per currency.
  A shipment's cost is the one exception to the Agreement's currency: it stays in the carrier's.

## Renewals

- **Agreements** (daily): within *renewal lead days* of the end date the account manager (or, without
  an active one, the asset managers) is emailed once. **Renew agreement** extends the end date by the
  renewal term; an end on the last day of a month stays on the last day of a month (28 Feb 2027 plus 3
  months is 31 May, plus 12 months is 29 Feb 2028). Any change of the end date (by the action or by
  hand) re-arms the warning, and a future end re-arms the end-of-agreement return.
- **OEM coverage** (daily): covered contracts of deployed fleet assets ending within
  `x_daas_ham.oem.coverage_warning_days` are warned about once, one email per Customer. Renewing
  with the manufacturer changes the end date at the next sync or CSV import, which re-arms the
  warning.
- If the *warned* mark of an Agreement or a coverage contract cannot be saved, it is logged and the
  email goes again the next day: sent at least once rather than not at all.
