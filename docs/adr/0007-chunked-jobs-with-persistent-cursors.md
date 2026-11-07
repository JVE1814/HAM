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
