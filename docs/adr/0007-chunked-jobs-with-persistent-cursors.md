# Bulk work runs as chunked jobs with persistent cursors

With 100k–1M Assets, every bulk process (lifecycle phase recalculation, spare-pool top-up, refresh
eligibility, reconciliation, OEM sync, billing) runs through one chunked-job runner: keyset paging by
an indexed key, a time budget per run, and a cursor persisted in `x_daas_ham_job_cursor` so the next
run resumes where the last stopped. Event-driven queues (only changed records) are preferred over
scans wherever a trigger exists. A cursor save the platform refuses is logged, and the next run
repeats from the last saved cursor.

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
