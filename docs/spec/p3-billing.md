# Billing periods and export (P3.25, D52, D66)

## What is billed

- **Service intervals** record the days each Asset delivered a Subscription line. A rule on stage
  changes opens one when the Asset enters service (in service or temporary): from its in-service
  date on first go-live, else that day (e.g. a missing unit found again). The same rule closes it
  the day the Asset leaves service (a Return order, declared missing, a manual move). Both days are
  billed. An Asset back in service on or before the day its interval on the same line closed gets
  that interval reopened, so no day is billed twice. The rule also runs when the stage change clears
  the Asset's Subscription line, so the interval still closes.
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
| Generating | Monthly job on day 1 (previous month), or *Regenerate* | Lines are written in time-boxed chunks (event-driven); a subscription line or fee event that fails to bill is counted on the period (*Lines that failed to bill*) with the last error (*Last generation error*). A chunk that cannot run at all (e.g. a month saved past the month rule) stops generation: its error is recorded and the period is held as *Ready for review*. *Close period* refuses while a line failed to bill or an error is recorded, until a *Regenerate* bills every line |
| Ready for review | Generation finished and totals are set, or generation stopped on an error (held for review) | *Regenerate* (rebuild from current data); *Close period* |
| Closed (locked) | *Close period* (finance) | Lines of fees waived since generation are dropped (Close refuses if a waived fee cannot leave the period) and the totals redone, and the fees become *billed*. The period and its lines can no longer change or be deleted. The CSV export is attached in the background shortly after closing; *Re-export CSV* attaches it again if it is missing |

- A period's month is entered as YYYY-MM (e.g. 2026-11); a business rule refuses a period saved with any other month. A period saved past the rule (e.g. by an import without business rules) bills nothing: its generation stops with the error recorded, and *Close period* refuses until the month is corrected and *Regenerate* run.

## Export

- **CSV** attachment `billing-YYYY-MM.csv`: period, kind, customer, agreement, subscription line,
  site, description, units, monthly rate, amount, currency. Built from the locked lines by the
  `x_daas_ham.billing.export` event shortly after closing; attaching it does not update the period,
  and a period that already has the file is skipped (delete it, then *Re-export CSV*, to rebuild it).
  Racing exports keep only the oldest copy; a failed export is logged as an error naming the period.
- **Pull API** (finance or integration role):
  - `GET /api/x_daas_ham/naas/billing_periods` lists recent periods with status and totals;
  - `GET /api/x_daas_ham/naas/billing_periods/{id}/lines?offset=0&limit=1000` returns one page of
    lines; `final` is true once the period is closed and `nextOffset` is null on the last page.

# Margin and TCO (P3.28, D72)

Closing a period (or **Recompute margin** on a closed one) rebuilds its **Cost facts** and
**Margin**, one row per Customer and Site (Site blank for customer-level amounts such as fees).

| Cost type | Source | Attributed by |
|---|---|---|
| Purchase | The Asset's cost, written off over `x_daas_ham.margin.amortisation_months` from its purchase date (else its in-service date), then no more (Provider-owned only; a buyout sets the cost to the Asset's share of the buyout price and the purchase date to the buyout day) | Service-interval days in the month from the write-off start |
| Lease | The lease's monthly payment split evenly over the Assets it covers, in months the lease runs (lessor-owned) | Service-interval days |
| OEM support | Annual cost of the coverage contracts covering the Asset today (`annual_cost`, from the coverage CSV or entered on the contract) ÷ 12 | Service-interval days |
| Field labour | NaaS work orders closed in the month: their *NaaS field labour cost*, else `x_daas_ham.margin.visit_cost` | The work order's company and location |

- Customer-owned Assets carry no capital cost.
- Costs use the Assets' current ownership, cost and coverage: *Recompute margin* on an old period
  reflects today's data. A recompute started while another is running supersedes it: each Cost fact
  records the recompute that wrote it (*Computation run*), and a recompute that completes drops the
  Cost facts of earlier ones, adds field labour and rebuilds Margin from its own; a superseded one
  stops before each of those steps, so the latest recompute's results are the ones left. Service intervals
  that fail to cost are left out, counted on the period (*Service intervals that failed to cost*) with
  the last error (*Last margin error*); both are cleared when a recompute starts.
- While a buyout transfer is still running, a lease's payment keeps being split over the Assets it
  covered when the buyout was decided.
- **Revenue** is the period's billing lines (subscriptions per Site, fees at Customer level).
- **Margin** = revenue − cost; margin % = margin ÷ revenue (blank without revenue).
- The workspace dashboard's **Margin** tab shows last month's revenue, cost and margin, margin by
  Customer over 12 months, and last month's cost by type.
