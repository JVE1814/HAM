# Models, lifecycle data and visibility (P1.1–P1.2)

## Normalization (`domain/normalization.ts`)

1. A raw model string equal to a canonical Model's OEM PID maps to it.
2. Otherwise the raw manufacturer is matched to a Manufacturer alias, ignoring case, punctuation and
   extra whitespace. Punctuation counts as a word break, so *Hewlett-Packard* matches *Hewlett Packard*
   but *H.P.* needs its own alias to match *HP*. A blank or punctuation-only manufacturer never matches.
3. Then the active Model match rules of that manufacturer run in `order`:
   - **exact** (case-insensitive);
   - **starts with**;
   - **regular expression** (case-insensitive; invalid patterns are skipped).

- Hourly, discovered hardware models without a PID are mapped. Their Assets are re-pointed to the
  canonical Model and the raw model records *normalized to*.
- Unmapped pairs become counted **normalization exceptions**. Setting *resolved model* on one creates
  an exact rule, and an alias if the manufacturer was unknown (none for a blank or punctuation-only
  one, which no alias could match).

## Lifecycle (`domain/model-lifecycle.ts`)

- One lifecycle record per Model. The CSV import accepts ISO dates of real calendar days (it refuses
  2026-02-31) and refuses milestones that go backwards.
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
| inventory tech only | Assets, stockrooms, transfer orders, staging tasks and audits (with their lines) of their stockrooms; plus, across all stockrooms and Customers, the ASN imports, staging steps and templates, Orders, Shipments, Return orders, OEM RMAs and Disposal orders; no other app table |
| customer admin | their Customer's Assets, Orders, lines, Agreements, subscription lines, catalog entries |
| site contact | Assets, Orders and lines of the Sites listing them as contacts |

Before-query rules add the filter and customer ACLs re-check it. Users with no stockroom, Site or
Customer see nothing in the restricted tables. The rules only narrow rows: tables a role may not read at
all are closed by their read ACLs (for inventory techs, `INVENTORY_TECH_TABLES` in
`domain/visibility.ts` lists what they read).
