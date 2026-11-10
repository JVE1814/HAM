# Bulk work runs as chunked jobs with persistent cursors

With 100k–1M Assets, bulk passes over Assets and the records that follow them run through one
chunked-job runner (`platform/chunked.ts` over `domain/chunked-job.ts`): keyset paging by sys_id, a
time budget per run, and a persisted cursor so the next run resumes where the last stopped.
Event-driven queues (only changed records) are preferred over scans wherever a trigger exists. The
runner is used in two ways:

- Scheduled, with the cursor in `x_daas_ham_job_cursor` (`runTableJob`): installed-base
  reconciliation (`reconcile_installed_base`), in-service detection (`in_service_detection`), raw
  model normalization (`normalize_raw_models`), overdue return chasing (`chase_overdue_returns`) and
  spare-pool top-up (`spare_pool_top_up`). A cursor save the platform refuses is logged, and the
  next run repeats from the last saved cursor.
- Event-driven, with the cursor in the event's `parm2` (`runEventTableJob`): the lifecycle phase
  and refresh date recalculation of a Model's, Agreement's or Lease's Assets (queued when the dates
  they are worked out from change, and by the daily lifecycle roll for the Models with a milestone
  that day), the lease buyout transfer, billing generation and the margin recompute (ADR 0013).

Other scheduled jobs do not use the runner. Each bounds its work its own way, or not at all:

- Refresh Orders (`platform/refresh.ts`) read due in-service fleet assets, earliest due first (then
  by sys_id), a page of 2000 at a time after the last one read, skipping those already on an open
  replacing line, until 2000 candidates are found, the Assets due run out, or the job time budget
  (`x_daas_ham.job.budget_seconds`) is spent (`domain/refresh.ts` `firstCandidatesDue`). No cursor
  is kept: each run starts from the earliest due, so Assets waiting on open Orders (a draft left for
  review, a replacement not yet installed) cost reads but no longer block later-due ones.
- OEM sync (`platform/oem-sync.ts`): the lifecycle sync reads every NaaS Model of each enabled
  vendor in one query; the coverage sync takes batches of stale Assets, oldest check first, until
  the time budget is spent, with no cursor since a checked Asset drops out of the query; the RMA
  status sync asks at most 200 open RMAs per vendor a run, least recently synced first.
- OEM claim and provisioning (`platform/claim-steps.ts` `runClaims`) makes at most
  `x_daas_ham.oem.claim.max_calls` adapter calls per vendor a run, holding its run lock. Before them
  it checks 200 waiting steps for stranded ones, in sys_id order from where the last run stopped
  (the `x_daas_ham_job_cursor` row `oem_claim_stranded`, which holds only that position), starting
  over after the last.
- Scheduled returns (`platform/scheduled-returns.ts` `raiseDueReturns`) take at most 50 ended
  Agreements and 50 ending temporary Orders a run; each one raised is flagged and drops out.
- Attestations (`platform/attestations.ts` `raiseDueAttestations`) read every in-service or
  temporarily deployed fleet asset of each active Agreement with an attestation interval, in one run
  with no time budget or cursor.
- Lease review (`platform/leases.ts` `runLeaseReview`) reads every undecided lease that ended no
  more than 30 days ago or ends later, in one query; the renewal warnings read every Agreement not
  yet warned, and the coverage-expiry warnings at most 5000 contracts a run.
- The installed-base reconciliation's exception clean-up, its *seen without asset* report (at most
  1000 CIs a run) and the rack re-check run after its chunked pass, unchunked. The device-event
  purge deletes with one query.

A record whose handling throws fails, and the pass moves on past it: only the next pass handles it
again. A refused save counts as a failure only where its handler throws for it (the lifecycle
recalculation does); a handler that logs the refusal itself and returns leaves it out. Every run or
chunk with failed records logs how many and the last error with `gs.error`. A scheduled job's cursor
also keeps its pass's failures, over all the runs the pass takes: `failed_total` and `last_error`,
cleared when a run starts a fresh pass. Its `last_status` reads *complete* only for a pass that
reached the end with no record failed; otherwise *complete with N failed record(s)*, or *paused
(time budget)* followed by *N failed record(s) so far*. An event-driven job keeps its failures where
its outcome is kept, through its `flush` (the billing period's failed lines, the margin period's
failure count). The lifecycle recalculation and the buyout transfer have no flush, and keep them
only in the log. A superseding pass (ADR 0013) marks its job cursor *running* as it starts and
*complete* once its last chunk is written. A completion the platform refuses is logged rather than
thrown, since the pass's own completion is already written, and the cursor reads *running* with an
old last run, as a stalled pass would, until the next pass starts.

A run whose first insert of the cursor record loses to another run doing the same (the unique index
on job) goes on from that run's record. When there is still no record, a scheduled job does not run
and the refusal is logged as an error, since without a cursor record every run would repeat the pass
from the start.

An event-driven job keeps no cursor row: each of its events names the job's subject (a Model, a
Lease schedule, a Billing period) in `parm1` and carries the chunk's position in `parm2`. Where a
fresh pass must replace one still queued (billing generation, the margin recompute of ADR 0013), the
job does keep a row, which holds the current pass's token, and each event's `parm2` is
`<token>:<position>`: a chunk whose token is no longer the row's writes nothing and queues nothing.
One runner and one repository of the rows (`platform/chunked.ts`, `platform/job-cursor.ts`) serve
all of these. The table also holds two rows that are not cursors, the Provider tag counter
(`provider_tag_sequence`) and the preflight check's last result (`preflight`).

Billing generation keeps one such row per period (`billing_generate_<period sys_id>`), with the
current pass's token and the time the last chunk started. So a reset or replaced pass's queued
chunks are dropped, and *Reset generation* can tell whether the generation is idle. A pass starts
where it is triggered (the period's insert, *Regenerate*), not from its first event, and, unlike
the margin recompute, no lock is taken: a chunk saves its start time before it checks
its pass, and the reset reads the cursor again after retiring the pass, so a chunk that starts in
between leaves the period generating. The row's `last_status` is *pass started* (or *reset by
hand*), not a running state, and nothing is recorded on it when a pass completes. A row reading
*pass started* with an old last run is not a sign of a stall: the period's status says whether the
pass finished.
