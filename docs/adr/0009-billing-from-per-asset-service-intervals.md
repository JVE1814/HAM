# Billing comes from per-asset service intervals

Per-device Subscription lines are billed from a Service interval per Asset (first day in service to
the day it leaves service), not from daily usage snapshots or from the Assets' current fields. An
Asset's line, Site and in-service date are cleared or overwritten when it comes back, so current
fields cannot reproduce a past month, and snapshots would cost one row per line per day. The
interval is opened and closed by one rule on stage changes into and out of a billable stage, so every
path (first go-live, a missing unit found again, a Return order, declared missing, a manual move)
starts or stops billing without each caller having to remember. The same rule moves the interval of
a unit that stays in service when its Subscription line or Site is changed, since an interval
records both as it opens: the old one ends that day and one at the new line and Site starts the day
after. Site packages are billed from
the line's own start and end dates, and per-device lines bill their Assets' Service intervals only
within those dates. So a unit still in service on an ended line stops billing at the line's end
date: it is flagged on the dashboard, not moved to another line.
