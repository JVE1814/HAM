# Margin is aggregated per period from current costs

Cost facts and Margin are computed when a Billing period closes, as one row per Customer, Site and
cost type for that period, not as per-Asset cost history. At 100k–1M Assets per-Asset monthly rows
would outgrow everything else in the app, and the dashboards only need Customer and Site totals.
The price is that a recompute uses each Asset's ownership, purchase cost, lease and coverage cost as
they are now: recomputing an old period after a buyout or a coverage change gives a different
answer. Billing lines, which customers are charged from, are locked; Margin is a management view
and may be recomputed.
