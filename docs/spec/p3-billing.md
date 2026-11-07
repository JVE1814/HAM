# Billing periods and export (P3.25, D52, D66)

## What is billed

- **Service intervals** record the days each Asset delivered a Subscription line. One opens when
  in-service detection attaches the Asset to its line (first day = in-service date). It closes on
  the day the Asset goes on a Return order (or, at the latest, when it is received back). Both
  days are billed.
- A **site package** line is billed from its start date to its end date (it ends when its last
  Asset is received back).
- A **per-device** line is billed per device-day: `monthly rate × device-days ÷ days in month`, one
  billing line per Site.
- Open **Fee events** up to the month end (lost, damaged, late return) are added once, each as its
  own line.
- Amounts are rounded to the cent per billing line.

## Lifecycle of a period

| Status | How it gets there | What can happen |
|---|---|---|
| Generating | Monthly job on day 1 (previous month), or *Regenerate* | Lines are written in time-boxed chunks (event-driven) |
| Ready for review | Generation finished; totals are set | *Regenerate* (rebuild from current data); *Close period* |
| Closed (locked) | *Close period* (finance) | Lines of fees waived since generation are dropped and the totals redone, and the fees become *billed*. The period and its lines can no longer change or be deleted. The CSV export is attached in the background shortly after closing; *Re-export CSV* attaches it again if it is missing |

## Export

- **CSV** attachment `billing-YYYY-MM.csv`: period, kind, customer, agreement, subscription line,
  site, description, units, monthly rate, amount, currency. Built from the locked lines by the
  `x_daas_ham.billing.export` event shortly after closing; attaching it does not update the period,
  and a period that already has the file is skipped (delete it, then *Re-export CSV*, to rebuild it).
- **Pull API** (finance or integration role):
  - `GET /api/x_daas_ham/naas/billing_periods` lists recent periods with status and totals;
  - `GET /api/x_daas_ham/naas/billing_periods/{id}/lines?offset=0&limit=1000` returns one page of
    lines; `final` is true once the period is closed and `nextOffset` is null on the last page.

# Margin and TCO (P3.28, D72)

Closing a period (or **Recompute margin** on a closed one) rebuilds its **Cost facts** and
**Margin**, one row per Customer and Site (Site blank for customer-level amounts such as fees).

| Cost type | Source | Attributed by |
|---|---|---|
| Purchase | The Asset's cost, written off over `x_daas_ham.margin.amortisation_months` from its purchase date (else its in-service date), then no more (Provider-owned only; a buyout sets the cost to the Asset's share of the buyout price) | Service-interval days in the month |
| Lease | The lease's monthly payment split evenly over the Assets it covers, in months the lease runs (lessor-owned) | Service-interval days |
| OEM support | Annual cost of the coverage contracts covering the Asset today (`annual_cost`, from the coverage CSV or entered on the contract) ÷ 12 | Service-interval days |
| Field labour | NaaS work orders closed in the month: their *NaaS field labour cost*, else `x_daas_ham.margin.visit_cost` | The work order's company and location |

- Customer-owned Assets carry no capital cost.
- Costs use the Assets' current ownership, cost and coverage: *Recompute margin* on an old period
  reflects today's data. A recompute started while another is running supersedes it.
- **Revenue** is the period's billing lines (subscriptions per Site, fees at Customer level).
- **Margin** = revenue − cost; margin % = margin ÷ revenue (blank without revenue).
- The workspace dashboard's **Margin** tab shows last month's revenue, cost and margin, margin by
  Customer over 12 months, and last month's cost by type.
