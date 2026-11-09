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

Billing generation is event-driven and carries each chunk's position in the event's `parm2`, but it
also keeps one `x_daas_ham_job_cursor` row per period (`billing_generate_<period sys_id>`). The row
holds the current pass's token, which each chunk's event carries in `parm1`, and the time the last
chunk started. So a reset or replaced pass's queued chunks are dropped, and *Reset generation* can
tell whether the generation is idle. No lock is taken: a chunk saves its start time before it checks
its pass, and the reset reads the cursor again after retiring the pass, so a chunk that starts in
between leaves the period generating. The row's `last_status` is *pass started* (or *reset by
hand*), not a running state, and nothing is recorded on it when a pass completes. A row reading
*pass started* with an old last run is not a sign of a stall: the period's status says whether the
pass finished.
