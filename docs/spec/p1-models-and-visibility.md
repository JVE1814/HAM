# Models, lifecycle data and visibility (P1.1–P1.2)

## Normalization (`domain/normalization.ts`)

1. A raw model string equal to a canonical Model's OEM PID maps to it.
2. Otherwise the raw manufacturer is matched to a Manufacturer alias, ignoring case, punctuation and
   extra whitespace.
3. Then the active Model match rules of that manufacturer run in `order`:
   - **exact** (case-insensitive);
   - **starts with**;
   - **regular expression** (case-insensitive; invalid patterns are skipped).

- Hourly, discovered hardware models without a PID are mapped. Their Assets are re-pointed to the
  canonical Model and the raw model records *normalized to*.
- Unmapped pairs become counted **normalization exceptions**. Setting *resolved model* on one creates
  an exact rule (and an alias, if the manufacturer was unknown).

## Lifecycle (`domain/model-lifecycle.ts`)

- One lifecycle record per Model. The CSV import accepts ISO dates and refuses milestones that go
  backwards.
- **Lifecycle phase** on a day is the latest milestone reached: end of sale → end of support → end of
  extended support → end of life.
- **Refresh due** = in-service date + the Agreement's refresh cycle, or the Model's end of support, or
  whichever is earlier, per the Agreement's refresh basis.
- Recalculation runs in time-boxed chunks:
  - for a Model, when its lifecycle record changes or a milestone date is reached (daily);
  - for an Agreement's deployed Assets, when its refresh terms change.

## Visibility (`domain/visibility.ts`, ADR 0005)

| User | Sees |
|---|---|
| asset manager, field tech, NOC, account manager, finance, admin | everything |
| inventory tech only | Assets, stockrooms, transfer orders and staging tasks of their stockrooms |
| customer admin | their Customer's Assets, Orders, lines, Agreements, subscription lines, catalog entries |
| site contact | Assets, Orders and lines of the Sites listing them as contacts |

Before-query rules add the filter and customer ACLs re-check it. Users with no stockroom, Site or
Customer see nothing in the restricted tables.
