# Bulk work runs as chunked jobs with persistent cursors

With 100k–1M Assets, every bulk process (lifecycle phase recalculation, spare-pool top-up, refresh
eligibility, reconciliation, OEM sync, billing) runs through one chunked-job runner: keyset paging by
an indexed key, a time budget per run, and a cursor persisted in `x_daas_ham_job_cursor` so the next
run resumes where the last stopped. Event-driven queues (only changed records) are preferred over
scans wherever a trigger exists. A cursor save the platform refuses is logged, and the next run
repeats from the last saved cursor.
