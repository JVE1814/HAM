# Billing comes from per-asset service intervals

Per-device Subscription lines are billed from a Service interval per Asset (first day in service to
the day it leaves service), not from daily usage snapshots or from the Assets' current fields. An
Asset's line, Site and in-service date are cleared or overwritten when it comes back, so current
fields cannot reproduce a past month, and snapshots would cost one row per line per day. The
interval is opened when in-service detection attaches the Asset to its line and closed by a rule on
any stage change out of a billable stage, so every exit path (Return order, declared missing, a
manual move) stops billing without each caller having to remember. Site packages are billed from
the line's own start and end dates.
