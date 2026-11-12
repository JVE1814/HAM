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
  one, which no alias could match). The rule is kept under the manufacturer the raw name's alias
  points at, which can differ from the resolved Model's (*Cisco* resolved to a Cisco Meraki Model).
  An exception whose alias or rule the platform refuses stays open with an error message (clear its
  resolved model and set it again to retry).

## Lifecycle (`domain/model-lifecycle.ts`)

- A Model's milestones are kept in the platform's Model lifecycle table (`cmdb_model_lifecycle`, ADR 0017), one
  row per Model and milestone: lifecycle type *Publisher*, the milestone as the lifecycle phase, its date as the
  phase start date. The app writes its rows as hardware lifecycle rows of source *Internal*, with where the date
  comes from (manual, CSV import, a vendor's API, and the bulletin it names) as the description. It reads every
  active Publisher row of the Model, so a milestone the Provider's IT keeps by hand or ServiceNow's content service
  supplies counts too; where two rows give the same milestone, the *Internal* one wins.
- The CSV import accepts ISO dates of real calendar days (it refuses 2026-02-31) and refuses milestones that go
  backwards, counted with the dates stored. A milestone a row leaves blank keeps the date stored; a row with no date
  at all is marked *ignored*.
  No row is ever removed by the app: a milestone stored by mistake is deactivated or deleted in the list by hand.
- **Lifecycle phase** on a day is the latest milestone reached: end of sale → end of support → end of
  extended support → end of life.
- **Refresh due** = in-service date + the Agreement's refresh cycle, or the Model's end of support, or
  whichever is earlier, per the Agreement's refresh basis.
- Recalculation runs in time-boxed chunks:
  - for a NaaS Model, when a milestone of its changes (a rule on the platform's table, which leaves the Provider
    IT's Models alone) or a milestone date is reached (daily);
  - for an Agreement's deployed Assets, when its refresh terms change.

## Visibility (`domain/visibility.ts`, ADR 0005)

| User | Sees |
|---|---|
| asset manager, field tech, NOC, account manager, finance, admin | everything |
| inventory tech only | fleet assets, NaaS stockrooms, transfer orders from or to a NaaS stockroom, staging tasks and audits (with their lines) of their stockrooms; plus, across all stockrooms and Customers, the ASN imports, staging steps and templates, Orders, Shipments, Return orders, OEM RMAs and Disposal orders, and the name of every Customer; no other app table; the Provider IT's hardware, stockrooms and transfer orders, and Model lifecycle milestones, as the platform allows |
| customer admin | their Customer's fleet assets (and no other company's hardware), Orders, lines, Return orders and lines, Shipments and events, Attestations and items, Agreements, subscription lines, catalog entries and Fee events; Site templates with their items, their Customer's and those offered to every Customer (checked by the read ACL, no before-query rule) |
| site contact | their Customer's fleet assets (and no other company's hardware), Orders and lines, Return orders and lines, Shipments and events, and Attestations and items at the Sites listing them as contacts; no Fee events |
| service desk (`sn_customerservice_agent`, no NaaS role) | every Customer's Agreements, Site templates with their items, Orders and lines, and Return orders and lines, to raise, submit and follow them (read ACLs of its own, in the features' `access.now.ts`); no other app table; hardware as the platform's ACLs allow |
| anyone else with no NaaS role | whatever the platform's ACLs and rules allow, fleet assets included |

On hardware, the app's own Provider columns (support cost, claim code and lease) are read by provider staff alone,
whoever reads the Asset, and a Customer contact does not read a fleet asset's *Cost*, which Customer Service's
ACLs grant its contacts, nor a Shipment's carrier cost (`fleet/access.now.ts`,
`delivery/access.now.ts`). A work order's *NaaS field labour cost* is read by provider staff alone, whoever reads
the work order, and changed by hand by asset managers and finance (`margin/margin.now.ts`).

**Platform tables staff read.** A reference shows, and a list is searched or grouped by it, only when the reader reads
its table and that table's display field. Provider staff read the Customers the app's records name
(`customer_account`, its *Name* only: no phone, address or other account field) and the broad staff the companies,
configuration items and purchase orders (`core_company`, `cmdb_ci`, `proc_po`), through the app's own Allow-If ACLs
(`shared/platform-access.now.ts`, `orders/access.now.ts`, `assurance/access.now.ts`). No staff role reads Customer
Service's cases, so the workspace shows no case column. Agreements and Lease schedules extend `ast_contract`, whose
field ACLs let only `contract_manager` read and search every field. The platform decides a field at the most specific
level with an ACL for it, ORing that level's ACLs: the field on the table, then on each table it extends, then
`*.<field>`, then `*` on the table and on each it extends. So the app's field ACLs on the two tables
(`agreements/access.now.ts`, `leases/access.now.ts`) name every role that reads each field: the broad staff, and on
Agreements the service desk, which reads an Agreement's number, short description, state, starts and ends (ADR 0005).

An inventory tech's stockrooms are the NaaS stockrooms whose *Assignment group* (the platform's
`alm_stockroom.assignment_group`) is a group they are a member of (ADR 0018).

Before-query rules add the filter; for a site contact it checks the record's Customer as well as its
Site, as the ACLs do, so another Customer's Site that lists them shows them nothing. Customer ACLs
re-check the Customer and, for a site contact without the customer admin role, that the record's
Site lists them as a contact, so neither a direct link nor a dot-walk from a visible record shows
another Site's records. Return lines, attestation items and shipment events have no before-query
rule: their ACL is the only check. Each table's scoping fields are written once, in `SCOPED_TABLES`
(`domain/visibility.ts`); the rules' one script (`scopeRecords`) and the ACLs' (`readsRecord`,
`grantsCustomerRecord`, `grantsFleetAsset`, all in `entry/visibility.ts`) find them by the record's table. Users with no stockroom, Site or
Customer see nothing in the restricted tables. For inventory techs the rules only narrow rows: tables they
may not read at all are closed by the read ACLs' role lists, not by a match-nothing filter, because a rule
also applies to the server logic their actions set off (`built-metadata.test.ts` lists what they
read and checks the built ACLs against it). For Customer contacts, a rule on a table with no Customer field (or no Site field,
for Site contacts) matches nothing: Site contacts get no NaaS Stockrooms, Agreements, subscription lines,
catalog entries or Fee events, and no Customer contact gets Staging tasks or transfer orders of NaaS
stockrooms.

**Shared tables** (ADR 0016). On `alm_hardware`, `alm_stockroom` and `alm_transfer_order`, which hold the
Provider IT's records too, the rules narrow an inventory tech's NaaS records only and keep the others in
(`outsideNaasConditions`): hardware outside the fleet (flag false or blank), stockrooms with no NaaS stockroom type, and
transfer orders between two such stockrooms. An inventory tech, who holds the platform's `asset` and `inventory_user`
roles, sees those as other asset users do. A Customer contact is kept to their Customer (and Sites) on every record of
those tables, fleet or not, as before: Customer Service's own contact rules on `alm_asset` run in interactive sessions
only, so they would not narrow a Table API read. Users with no NaaS role are narrowed by none of the app's rules.

**Hardware ACLs.** The app's read ACLs for hardware sit on `alm_asset`, the parent table, applying to hardware
(*Applies To* `sys_class_name=alm_hardware`). The platform has no record read ACL on `alm_hardware` (the CRM Base
Entities one of that name is a UI page ACL), so `alm_hardware` inherits `alm_asset`'s, where the app's Allow-If ACLs are
ORed with Asset Management's and Customer Service's: they grant NaaS provider staff and Customer contacts the fleet
assets their scope keeps, and nothing else. When they sat on `alm_hardware` they were its only ACLs, and every user
without a NaaS role lost all hardware.

**Row checks.** A rule can only append conditions, and one appended after an `^NQ` binds to the last clause only,
so a list query with `^NQ` clauses or a direct link could reach a record the rule hides. Each table the rules
narrow to an inventory tech's stockrooms (those whose `SCOPED_TABLES` entry names a Stockroom) therefore has a Deny-Unless read ACL
(`shared/visibility.now.ts`), hardware's on `alm_asset` so an `alm_asset` list is checked too. Its script checks
the record with `rowVisible` on the same `SCOPED_TABLES` entry as the table's rule and keeps exactly what the rule keeps: an
inventory tech with no broader role reads a fleet asset, NaaS stockroom, transfer order touching a NaaS stockroom,
staging task or audit only of their stockrooms, and a Customer contact hardware and the other records only of their
Customer (and Sites). Staff who see everything and users with no NaaS role pass it, and so does a record that is not
a saved row (a New form, a check of the whole table). It is Deny-Unless because the platform's own Allow-If read ACLs
on `alm_asset`, `alm_stockroom` and `alm_transfer_order` already grant an inventory tech every row, and Allow-If ACLs
of one name are ORed. A server read is not checked by ACLs: one with `^NQ` clauses that the app returns to a
restricted user carries the user's filter in each clause itself (the customer page's equipment).
