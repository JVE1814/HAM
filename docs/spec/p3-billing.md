# Billing periods and export (plan §13 Billing export, Q52, Q66)

## What is billed

- **Service intervals** record the days each Asset delivered a Subscription line. A rule on stage
  changes opens one when the Asset enters service (in service or temporary): from its in-service
  date on first go-live, else that day (e.g. a missing unit found again). The same rule closes it
  the day the Asset leaves service (a Return order, declared missing, a manual move). Both days are
  billed. An Asset back in service on or before the day its interval on the same line closed gets
  that interval reopened, so no day is billed twice. The rule also runs when the stage change clears
  the Asset's Subscription line, so the interval still closes.
- The rule opens or reopens the interval under a job lock on the Asset (`service_interval_<sys_id>`,
  ADR 0013), so two saves that put it in service at once (a Seen signal and the detection job) open
  one interval. The opening and the closing for one Asset take turns under that lock, and each reads
  its stage afresh. An Asset taken out of service before its go-live's rule ran gets its interval
  opened and closed that day. One put back in service before its close ran keeps its interval open.
  A save that cannot take the lock after 5 tries leaves the interval to the holder, and logs an error
  if the interval is then not open (or still open for an Asset out of service), to fix by hand if the
  save holding the lock does not. An interval the platform refuses to open or close is logged as a
  warning, for finance to fix by hand.
- A **site package** line is billed from its start date to its end date (it ends on the day its last
  Asset at the Site is received back or declared missing, while no other Asset under its Agreement is
  on its way to, at or pending return from that Site).
- A **per-device** line is billed per device-day: `monthly rate × device-days ÷ days in month`, one
  billing line per Site. Its Assets' days count only within the line's own start and end date (the
  end date is billed; no end date means still open), and a line without a start date bills nothing.
  A unit still in service after its line ended is not billed past the end date. It is counted on the
  workspace dashboard's *Billing integrity* tab, tile *In service on an ended line* (fleet assets in
  service or on a temporary deployment whose line is set ended or past its end date), and is never
  moved to another line.
- The *Billing integrity* tab counts fleet assets only (ADR 0016): the Provider IT's equipment in use
  shares `alm_hardware` and is never billed. Its tile *In service without a subscription line*
  counts fleet assets in service with no Subscription line, which bill nothing.
- Open **Fee events** up to the month end (lost, damaged, late return) are added once, each as its
  own line. A fee a *Regenerate* no longer bills (its date moved past the month end, or it fails
  to bill) leaves the period, so *Close period* does not mark it billed and a later month bills it.
  A fee is billed under its job lock (ADR 0013), only while it is open and on no other period, so
  two periods generating at once never both bill it. One whose lock another run holds through 5
  tries fails to bill, unless another period has it by then.
- Amounts are rounded to the cent per billing line, half away from zero, in whole numbers: a monthly
  rate is taken to four decimals, so a charge of exactly half a cent (0.29 a month for 14 of 28 days)
  is 0.15, not the 0.14 binary fractions would give.
- **Currency**: each Agreement bills in one currency, its mandatory *Currency* (a three-letter ISO
  code such as EUR) with no default. A Subscription line's billing lines and a Fee event's line take
  the currency of the Agreement they name; the line's and the fee's own *Currency* fields are not
  used. A fee naming no Agreement takes the currency all of its Customer's Agreements have. A line or
  fee whose currency is not known (its Agreement has none, or not a three-letter code; a fee naming
  no Agreement whose Customer's Agreements have several, or none) fails to bill and is counted with
  why (*no currency: its Agreement NAG0001001 has no currency...*), so *Close period* refuses until
  the Agreement is fixed and the period regenerated.
- Amounts of two currencies are never added. A period's *Totals per currency* holds one total per
  currency (e.g. `EUR 1234.56; USD 99.00`, in currency order); its *Total* is set only while every
  line is in one currency, and is blank when they are in several.

## Lifecycle of a period

| Status | How it gets there | What can happen |
|---|---|---|
| Generating | A new period: the monthly job opens the previous month on day 1 unless it already has a period, or finance creates one by hand for a month that has ended (before the current month by UTC date). Either way, the insert starts its generation once. Or *Regenerate* | Lines are written in time-boxed chunks (event-driven); a subscription line or fee event that fails to bill is counted on the period (*Lines that failed to bill*) with the last error (*Last generation error*), and so is a fee whose link to the period is refused (a *Regenerate* links it). A chunk that cannot run at all (e.g. a month saved past the month rule), or whose failed-line count the period refuses, stops generation: its error is recorded and the period is held as *Ready for review*. If the period refuses that save, or the *ready* save at the end of generation, it stays *Generating* with nothing queued: the error is logged, *Close period* and *Regenerate* both refuse it, and once the cause is fixed an admin uses *Reset generation* (below). *Close period* refuses while a line failed to bill or an error is recorded, until a *Regenerate* bills every line |
| Ready for review | Generation finished and totals are set, or generation stopped on an error (held for review) | *Regenerate* (rebuild from current data: the period is saved as *Generating* before its lines are deleted, so a refused save keeps it ready with its lines; if any old line is left after the delete, it goes back to *Ready for review* with the error recorded and nothing is generated, so no line is billed twice; if the platform refuses that save too, it stays *Generating* with nothing queued, which is logged and shown: once it has shown no activity for 30 minutes an admin uses *Reset generation*, then *Regenerate*); *Close period* |
| Closed (locked) | *Close period* (finance) | Lines of fees waived since generation are dropped (a waived fee leaves the period only once its line is gone; if its line survives the delete or its unlink is refused, it stays on the period and Close refuses, naming the first three such fees, how many more there are, and why) and the totals redone; the period is saved closed before its fees become *billed*, so a refused save leaves them open. Each fee is then saved as *billed* and checked: one the platform refuses stays open but linked to the closed period, which no later period bills, so Close names the first three (and how many more) with why, logs them all, and they are set to *Billed* by hand. The period and its lines can no longer change or be deleted, and none of its lines can be moved to another period (nor a line moved into it). The CSV export is attached in the background shortly after closing; *Re-export CSV* attaches it again if it is missing |

- A period's month is entered as YYYY-MM (e.g. 2026-10); a business rule refuses a period saved
  with any other month, or with a month that has not ended. The period's first and last day are set
  from its month whenever the month is saved.
- A period whose month is changed after it was created still holds the old month's lines and fees
  (both months', if changed while generating). The change is recorded as its *Last generation
  error*, so *Close period* refuses until *Regenerate* bills the new month.
- A period whose month is changed past the rule bills nothing: its generation stops with the error
  recorded, and *Close period* refuses until the month is corrected and *Regenerate* run. A period
  inserted without business rules does not start generating: delete it and create it again, or, 30
  minutes after it was saved, an admin uses *Reset generation* and then *Regenerate*.
- A period can be created, or its month changed, only for a month that has ended: one before the
  current month by the instance's UTC date. The current or a later month is refused, since a new
  period is generated at once and would bill part of the month, and the monthly job would then skip
  it. The monthly job only opens last month, so the month rule never refuses it; any other refusal is
  logged as an error and the month must be created by hand.
- **Reset generation** (admins only) works on a period in *Generating* whose generation has shown no
  activity for 30 minutes. Activity is the later of the period's last save and the last chunk start
  on its job cursor (`billing_generate_<period sys_id>`); a period with no job cursor can be reset
  too. Reset retires the pass, so its chunks still queued are dropped, even once a *Regenerate* has
  the period generating again. It holds the period as *Ready for review*, with *Generation reset by
  hand by <user> after N minutes without activity...* as its *Last generation error* and the totals
  of the lines written so far, and *Close period* refuses it until a *Regenerate*. Reset deletes and
  bills nothing. A chunk that starts during the reset leaves the period *Generating*: reset again 30
  minutes later.
- Each generation pass is recorded on that job cursor, with a token its events carry in `parm2`,
  ahead of the chunk's position (`parm1` is the period). Chunks of a pass reset or replaced since,
  and events that name no pass or no period, are dropped with a warning. A pass whose cursor cannot
  be saved does not start: the period is held as *Ready for review* with the error. The
  *Background jobs* list (Administration) shows one
  `billing_generate_<period sys_id>` row per period. Its *Cursor* is the current pass's token (empty
  once reset), *Last run* the latest chunk start, and *Last status* *pass started* or *reset by
  hand*. The period's own status says whether the pass finished. Rows are not removed when a period
  is deleted.

## Export

- **CSV** attachment `billing-YYYY-MM.csv`: period, kind, customer, agreement, subscription line,
  site, description, units, monthly rate, amount, currency. Text that starts with `=`, `+`, `-`, `@`,
  a tab or a carriage return (a description, a customer's name) is written with a leading apostrophe,
  so a spreadsheet opens it as text rather than running it as a formula; numbers are written as they
  are. Built from the locked lines by the `x_daas_ham.billing.export` event shortly after closing;
  attaching it does not update the period, and a period that already has the file is skipped (delete
  it, then *Re-export CSV*, to rebuild it).
  Racing exports keep only the oldest copy; a failed export is logged as an error naming the period.
- **Pull API** (finance or integration role):
  - `GET /api/x_daas_ham/naas/billing_periods` lists recent periods with status, line count and
    `totals`;
  - `GET /api/x_daas_ham/naas/billing_periods/{id}/lines?offset=0&limit=1000` returns one page of
    lines, each with its `currency`, and the period's `totals`; `final` is true once the period is
    closed and `nextOffset` is null on the last page.
  - `totals` is one entry per currency, in currency order: `{ "currency": "EUR", "lines": 12,
    "amount": 1234.56 }`, counted and summed from the period's lines (there is no single total: two
    currencies are never added).

# Margin and TCO (plan §13 Margin / TCO, Q72)

Closing a period (or **Recompute margin** on a closed one) rebuilds its **Cost facts** and
**Margin**, one row per Customer, Site and currency (Site blank for customer-level amounts such as
fees).

| Cost type | Source | Attributed by |
|---|---|---|
| Purchase | The Asset's cost, written off over `x_daas_ham.margin.amortisation_months` from its purchase date (else its in-service date) through the day before the same date that many months later, then no more. A write-off that starts mid-month ends mid-month, and its last month carries what its first month left of a monthly write-off, so an Asset in service throughout is costed exactly its cost (Provider-owned only; a buyout sets the cost to the Asset's share of the buyout price and the purchase date to the buyout day) | Service-interval days in the month from the write-off start through its last day |
| Lease | The lease's monthly payment split evenly over the fleet assets it covers (retired units, which the Lessor or the OEM holds, are not covered, nor is equipment of the Provider IT's, ADR 0016), in months the lease runs (lessor-owned) | Service-interval days |
| OEM support | Annual cost of the coverage contracts covering the Asset today (`annual_cost`, from the coverage CSV or entered on the contract) ÷ 12 | Service-interval days |
| Field labour | NaaS work orders closed in the month: their *NaaS field labour cost* (an explicit 0 costs nothing), else, when it is blank, `x_daas_ham.margin.visit_cost` | The work order's company and location |
| Shipping | Shipment labels bought in the month (the Shipment's creation) with a cost, except voided ones (the carrier refunds them): their cost | The Shipment's Customer and Site |

- **Currency**: each cost is kept in one currency and amounts of two currencies are never added. A
  Service interval's costs take the currency of its Subscription line's Agreement; a work order's,
  that of the Agreement its Order or Return order names, else the one currency all of its Customer's
  Agreements have (a site audit's). A shipment's cost stays in the carrier's currency, as the
  aggregator gave it with the label, and is never converted. Revenue in one currency is never set
  against cost in another: a Customer and Site with amounts in two currencies get one Margin row per
  currency (a label the carrier charged in USD, for a Customer invoiced in EUR, shows as a USD row
  with cost only).
- A Service interval whose Asset is gone, or whose currency is not known, a work order whose currency
  is not known, and a shipment with a cost but no currency are left out of Cost facts and Margin and
  counted on the period with the others (*Records that failed to cost*, below).
- Amounts are rounded to the cent half away from zero. Each chunk of Service intervals adds its sums
  to the Cost facts rounded to the cent, so a Cost fact may differ by a fraction of a cent from
  rounding the month's total once. Margin sums the Cost facts and billing lines per Customer, Site
  and currency, then rounds, and margin % is rounded to one decimal the same way.
- Customer-owned Assets carry no capital cost.
- Costs use the Assets' current ownership, cost and coverage: *Recompute margin* on an old period
  reflects today's data. A recompute started while another is running supersedes it: the new one
  starts afresh and the older one writes nothing more (its start, each batch it writes and its
  completion take a job lock, ADR 0013), so the latest recompute's results are the ones left. One that
  held the lock so long that it was taken as abandoned and cleared writes nothing more and starts the
  recompute over, so the period is recomputed from scratch. Service intervals that fail to cost are
  left out, counted on the period (*Records that failed to cost*, with the work orders and shipments
  that failed) with the last error (*Last margin error*); both are cleared when a recompute starts.
  If the period refuses that clearing, the pass stops (logged) before it clears the period's Cost
  facts and Margin. If clearing the period's old Cost facts or Margin rows leaves a row behind (a rule
  can keep one), as the pass starts or as it rewrites Margin at the end, the pass stops too: *Last
  margin error* reads *stopped: old Cost facts not all removed* (or *old Margin rows not all
  removed*), the error is logged, and the next *Recompute margin* clears the period again.
- While a buyout transfer is still running, a lease's payment keeps being split over the Assets it
  covered when the buyout was decided.
- Otherwise a lease's payment is split over the Assets it covers now: units the Lessor or the OEM has
  taken back (retired) no longer count, so a period recomputed after all of a lease's units have gone
  back carries no lease cost for it (ADR 0010).
- **Revenue** is the period's billing lines (subscriptions per Site, fees at Customer level).
- Assets still in service on an ended per-device line keep being costed by their Service-interval
  days, but their revenue stops at the line's end date. Their cost therefore shows as lost margin
  until the line or the unit is fixed (the *In service on an ended line* tile flags them).
- **Margin** = revenue − cost; margin % = margin ÷ revenue (blank without revenue).
- The workspace dashboard's **Margin** tab shows last month's revenue, cost and margin, margin by
  Customer over 12 months, and last month's cost by type. Its tiles sum Margin rows and Cost facts
  whatever their currency: with Agreements in several currencies, read the Margin list per currency.
