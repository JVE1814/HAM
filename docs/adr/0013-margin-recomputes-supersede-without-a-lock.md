# Margin recomputes supersede each other without a lock

A fresh *Recompute margin* supersedes one still running. The chunked event runner gives each pass a
token (its start time), tags every Cost fact with it, and checks that its pass is still current as a
chunk starts, before it flushes and once it has flushed; the margin pass checks again before each of
its completion writes (drop older passes' facts, add field labour, write Margin), and only the pass
named on the Billing period adds to its margin failure count. A pass superseded at any of those points
stops, and the newest pass's completion replaces whatever an older one wrote, so the period ends with
the newest pass's results.

What remains is the instant between one of those checks and the statement after it: a pass that
starts exactly then is not seen by that statement, and its own completion corrects the result. We
accept that instead of a lock. `GlideMutex` is not available to scoped applications, and a lock built
from a row behind a unique index would have to be taken by every chunk's flush and by each pass's
start and completion; a lock left behind by a transaction that died would then stall recomputes until
it is taken as abandoned, which is worse than a window that the next completion repairs. Margin is a
recomputable management view (ADR 0010), not the bill.
