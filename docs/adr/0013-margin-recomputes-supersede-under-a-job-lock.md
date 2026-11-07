# Margin recomputes supersede each other under a job lock

A fresh *Recompute margin* supersedes one still running, and an older pass must not write after the
fresh one has started: its Cost facts would sit beside the fresh pass's, or its completion would
replace the fresh Margin. Checking "still current?" before each write leaves the instant between the
check and the write open, so the event runner makes the check and the write one critical section. A
pass's start (new token, period cleared), each chunk's flush (Cost facts and failure counts) and the
pass's completion (field labour, Margin) hold the job's lock, and each checks under it that its pass
is still the current one. A fresh pass can then only start between them, and a superseded chunk
writes nothing.

`GlideMutex` is not available to scoped applications, so the lock is a row in `x_daas_ham_job_lock`
behind a unique index: taking it is one insert that only one holder wins, and releasing it deletes the
row. A chunk that finds the lock held writes nothing and runs again a minute later from the same
pass and cursor, so nothing is lost or written twice; that holds because a superseding job's `handle`
only accumulates in memory and every write happens under the lock. A lock held for over ten minutes is
taken as abandoned (its holder's transaction died) and cleared by the next taker, so a crash delays
recomputes instead of stalling them; a holder still running then finds before completing that it lost
the lock and leaves the period to the fresh pass. A chunk that throws records why on the period, under
the lock and only for the current pass. An insert refused while no lock row exists throws instead of
retrying forever. Whether the instance behaves as expected is on the first-install checklist.
