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
  canonical Model, and only then does the raw model record *normalized to*: one Asset whose save is
  refused leaves it unmarked, so the next run retries.
- Unmapped pairs become counted **normalization exceptions**. Setting *resolved model* on one creates
  an exact rule, and an alias if the manufacturer was unknown (none for a blank or punctuation-only
  one, which no alias could match). An exception whose alias or rule the platform refuses stays open
  with an error message (clear its resolved model and set it again to retry).

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
| customer admin | their Customer's Assets, Orders, lines, Return orders and lines, Shipments and events, Attestations and items, Agreements, subscription lines, catalog entries and Fee events; Site templates with their items, their Customer's and those offered to every Customer (checked by the read ACL, no before-query rule) |
| site contact | their Customer's Assets, Orders and lines, Return orders and lines, Shipments and events, and Attestations and items at the Sites listing them as contacts; no Fee events |

Before-query rules add the filter; for a site contact it checks the record's Customer as well as its
Site, as the ACLs do, so another Customer's Site that lists them shows them nothing. Customer ACLs
re-check the Customer and, for a site contact without the customer admin role, that the record's
Site lists them as a contact, so neither a direct link nor a dot-walk from a visible record shows
another Site's records. Return lines, attestation items and shipment events have no before-query
rule: their ACL is the only check. Users with no stockroom, Site or
Customer see nothing in the restricted tables. For inventory techs the rules only narrow rows: tables they
may not read at all are closed by the read ACLs' role lists, not by a match-nothing filter, because a rule
also applies to the server logic their actions set off (`INVENTORY_TECH_TABLES` in `domain/visibility.ts`
lists what they read). For Customer contacts, a rule on a table with no Customer field (or no Site field,
for Site contacts) matches nothing: Site contacts get no Stockrooms, Agreements, subscription lines,
catalog entries or Fee events, and no Customer contact gets transfer orders or Staging tasks.
