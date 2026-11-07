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
| Ready for review | Generation finished; totals are set | *Regenerate* (rebuild from current data, e.g. after waiving a fee); *Close period* |
| Closed (locked) | *Close period* (finance) | The CSV export is attached, its fees become *billed*. The period and its lines can no longer change or be deleted |

## Export

- **CSV** attachment `billing-YYYY-MM.csv`: period, kind, customer, agreement, subscription line,
  site, description, units, monthly rate, amount, currency.
- **Pull API** (finance or integration role):
  - `GET /api/x_daas_ham/naas/billing_periods` lists recent periods with status and totals;
  - `GET /api/x_daas_ham/naas/billing_periods/{id}/lines?offset=0&limit=1000` returns one page of
    lines; `final` is true once the period is closed and `nextOffset` is null on the last page.
