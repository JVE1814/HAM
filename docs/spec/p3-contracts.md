# Leases and renewals (P3.23–P3.24)

## Lease schedules (D65)

- A **Lease schedule** extends `ast_contract`: Lessor, schedule number, monthly payment (all its
  Assets), buyout price, end date, and how many days ahead the decision is due (default 120).
- An Asset is covered by setting its *Lease schedule*. Its Legal owner becomes *lessor* and its
  Lessor the schedule's Lessor.
- **Mismatch** (daily): a lease whose Assets serve Customers (shipped, pending in service, in
  service, temporary) under an Agreement that ends after the lease, or has no end date, is flagged
  and the asset managers are emailed once.
- **End-of-lease decision** (daily): within the lead time of the end date, one decision task is
  raised (assigned to `x_daas_ham.leases.decision_group`) with the counts of covered and deployed
  Assets and the mismatch flag.

## Applying a decision

| Decision | Effect |
|---|---|
| Buy out | Every covered Asset becomes Provider-owned and leaves the schedule, in a background job (chunked, so large leases do not time out the UI action); when a buyout price is recorded, each Asset's cost becomes its share of it, fixed once on the lease (*Buyout cost per asset*, *Assets covered at buyout*) when the decision is applied. The daily review queues the transfer again for a bought-out lease that still has Assets |
| Extend | The lease runs to the new end date (which must be later); a new decision comes due before it |
| Return | Stock (available, spare pool) goes on a draft *return to lessor* disposal order. Deployed Assets (including ones shipped or awaiting first sighting) get a Refresh due date no later than the lease end, so automatic refresh replaces them; the swapped-back units are returned and evaluated as usual (lessor-owned units can only be returned to the lessor) |

## Renewals

- **Agreements** (daily): within *renewal lead days* of the end date the account manager (or the
  asset managers) is emailed once. **Renew agreement** extends the end date by the renewal term
  and re-arms the warning and the end-of-agreement return.
- **OEM coverage** (daily): covered contracts of deployed Assets ending within
  `x_daas_ham.oem.coverage_warning_days` are warned about once, one email per Customer. Renewing
  with the manufacturer changes the end date at the next sync or CSV import, which re-arms the
  warning.
