# Visibility enforced by before-query rules on indexed fields, backed by row checks

Inventory techs only see their assigned Stockrooms (the NaaS stockrooms whose Assignment group they
are a member of, ADR 0018); Customer admins and Site contacts only see their
Customer (and Site contacts only their Sites). This is enforced by before-query business rules that
add indexed filters, backed by ACLs. ACL-only row filtering at 100k–1M Assets produces slow lists and
"rows removed by security constraints" gaps. Provider staff other than inventory techs see all
Customers; per-account-team scoping is deliberately left out until a contract demands it.

What a reader may see of a table is decided in one place: the table's entry in `SCOPED_TABLES`
(`domain/visibility.ts`), which names the fields that carry its Stockroom, Customer and Site and, on a table shared
with the Provider's IT, what tells its NaaS records. The filter a rule adds (`visibilityFilter`) and the check a read
ACL makes on one record (`rowVisible`, `grantsNaasRecord`, `grantsContactRecord`) are both read from that entry. Every
rule runs one script (`entry/visibility.ts` `scopeRecords`), every row check one (`readsRecord`) and every Customer
contacts' read ACL one (`grantsCustomerRecord`; `grantsFleetAsset` for hardware): each finds the entry by the table of
the record it is handed, so the metadata chooses nothing but the table a rule or an ACL sits on. A rule on a table
also runs for the queries of the tables that extend it, so a table with no entry of its own takes that of the nearest
table it extends (`GlideTableHierarchy`). A table with no entry there either cannot be reached by the rules and ACLs
as wired; were one put on such a table, a reader the rules narrow would be shown none of it and the script would log a
warning, so the mistake hides records and never shows them.

For inventory techs the rules only narrow rows. They filter the tables that carry a Stockroom: stock,
Stockrooms, transfer orders, Staging tasks, and Audits with their lines (a site audit has no Stockroom,
so it drops out). The other tables of their work, such as Orders, Shipments and Return orders, serve
every Customer and are not narrowed. Tables inventory techs may not read at all (the customer,
commercial and configuration tables) are closed by the read ACLs' role lists, not by a match-nothing
filter: a before-query rule also applies to the server logic the user's actions set off. Receiving a
returned Asset, for example, reads and can end its Subscription line and record a late-return Fee
event. Server logic that must count past the user's rules reads past them: the units of a site
package still at the Site, the Assets of an Order line when its stage is derived, the Assets Ship
sends, every device in a rack, and the unit a receipt or a device event names. On the app's own
tables it queries with business rules off (`setWorkflow(false)`) or with the mark below. On
`alm_hardware`, a table of another scope, the platform refuses `setWorkflow` from the app's scope
and runs the rules anyway, so the read marks its GlideRecord while its query runs (`platform/beyond-
visibility.ts`) and the app's before-query rules leave a marked record's query as it is. The mark
lives in a module, which only the app's code can load and which no other transaction shares, and it
is the record itself, so it skips the rules for that one query and no other; rules of other scopes
(the platform's, Customer Service's on `alm_asset`) still run. A record read that way is saved with
every rule, so the stage-change and billing rules run.

For Customer contacts, a rule on a table with no Customer field (or no Site field, for Site contacts)
matches nothing. Site contacts therefore get no NaaS Stockrooms, Agreements, subscription lines, catalog
entries or Fee events, and no Customer contact gets Staging tasks or transfer orders of NaaS Stockrooms. The backing
customer read ACLs check the Customer and, for a site contact who is not also a customer admin, that
the record's Site lists them as a contact: a dot-walk from a visible record and the tables with no rule
(return lines, attestation items, shipment events, and Site templates with their items) rely on the ACL alone. Their
script (`grantsCustomerRecord`) makes the rule's own decision on the one record, for the contact the ACL's roles
admit: a Customer admin by their Customer, any other contact by their Sites too, whatever staff role the user also
holds, since staff read through their own ACLs. A Site template with no Customer is every Customer's
(`sharedWithoutCustomer`). The reader's Customer and Sites are those the rules filter on, read once per transaction, so
a contact whose user has no Company is granted no other record, one with no Customer included.

On the tables the app shares with the Provider's IT (ADR 0016), `alm_hardware`, `alm_stockroom` and
`alm_transfer_order`, an inventory tech is narrowed on the NaaS records only: fleet assets, NaaS stockrooms (those
with a NaaS stockroom type) and transfer orders from or to a NaaS stockroom. For them the rule on each table ORs the
records outside NaaS (`outsideNaasConditions` in `domain/visibility.ts`) into each condition of its filter, so those stay in,
and the platform's own ACLs and rules alone decide whether they see them: an inventory tech holds the platform's
`asset` and `inventory_user` roles and sees the Provider IT's hardware and stockrooms as other asset users do. A
Customer contact is kept to their Customer (and Sites) on every record of those tables, fleet or not, as before the
fleet (`leavesOutsideNaas`). Customer Service's own narrowing of a contact on `alm_asset` is a pair of before-query
rules that run in interactive sessions only, so it does not narrow a contact's Table API read, and hiding another
company's hardware from a contact hides nothing the Provider's IT needs. Users with no NaaS role (the service desk, IT
asset managers, Customer Service agents) are not narrowed by the app's rules. The app's own reads keep themselves to
the fleet (ADR 0016).

The app's read ACLs for hardware sit on `alm_asset`, the parent table, not on `alm_hardware`. The platform has no
record read ACL on `alm_hardware` (Brazil, read-only, 2026-11-09: the CRM Base Entities ACL named `alm_hardware`, which
grants `snc_internal`, `sn_esm_user` and `sn_customerservice.requester`, is a UI page ACL, type `ui_page`, and so is
its `alm_asset` namesake). The platform takes a record's ACLs from the most specific table that has any, so with no
ACL of its own `alm_hardware` inherits `alm_asset`'s: Asset Management's (`snc_internal`, whose script, under
`sn_itam_restrict_asset_read`, keeps a user holding only a base role to the Assets that name them, as assigned to,
managed by, owned by and the like) and Customer Service's (`sn_esm_user`, `sn_customerservice.requester`, which checks
each row against its query rules). The app's earlier ACLs on `alm_hardware` were the only ones there, so they decided
every hardware read: everyone without a NaaS role lost all hardware. On `alm_asset` the app's Allow-If ACLs (NaaS
provider staff, Customer contacts) are ORed with the platform's, apply to hardware (*Applies To*
`sys_class_name=alm_hardware`) and grant only fleet assets the reader's scope keeps (`entry/visibility`
`grantsFleetAsset`), so they add readers of fleet assets and decide nothing else.

A before-query rule can only append conditions, and one appended after an `^NQ` binds to the last clause only, so a
list query with `^NQ` clauses, like a direct link or a dot-walk, can reach a record the rule would hide. So each table
the rules narrow to an inventory tech's Stockrooms also has a Deny-Unless read ACL, a row check
(`security/acls-visibility.now.ts`); hardware's sits on `alm_asset` with the others, so an `alm_asset` list, which the
`alm_hardware` rule does not narrow, is checked too. Its script (`entry/visibility.ts` `readsRecord`) runs
`domain/visibility` `rowVisible` on the same `SCOPED_TABLES` entry as the table's rule, which keeps exactly
the records the rule's filter keeps, on every record of the table: it passes staff who see every Customer and users
with no NaaS role, passes an inventory tech the records outside NaaS, and re-checks a Customer contact's Customer and
Site. A record that is not a saved row (a New form, which inventory techs open on Audits and Staging tasks, or a check
of the whole table) passes: it holds nothing to hide. It is Deny-Unless because Allow-If ACLs of one name are ORed, and
the platform's Allow-If read ACLs on `alm_asset`, `alm_stockroom` (`snc_internal`) and `alm_transfer_order`
(`inventory_user`, `asset`, `procurement_user`) already grant an inventory tech every row: every Deny-Unless ACL that
applies must pass, before an Allow-If one grants. The rules stay the efficient narrowing: a list without `^NQ` holds
only records the check passes, so it shows no "removed by security constraints" gaps.

## Consequences

- Whether a record is left to the platform depends on the reader (an inventory tech's hardware outside the fleet, not
  a Customer contact's), which *Applies To* cannot express, so the row checks on the shared tables have none and their
  script decides. On `alm_asset` *Applies To* keeps them off the other classes of Asset (consumables, licences,
  facilities), which the script passes all the same. So no verdict depends on how the platform treats an ACL whose
  *Applies To* a record does not match: no table is left with only such ACLs, and whether the platform would then fall
  back to the parent table's does not arise.
- The row checks run for every row any user reads of the tables they guard, hardware included. For a user the rules
  do not narrow the script stops at the reader's scope, which `platform/session.ts` resolves once per user and
  transaction (external-contracts N37), as it does their Stockrooms and Sites, so a row costs no query. A row of an
  `alm_asset` list, which carries no hardware field, is checked on its `alm_hardware` record, read once for the row
  and only for a user holding a NaaS role.
- An inventory tech's `alm_asset` list is not narrowed by a rule: the `alm_hardware` rule does not run on it, and a
  rule on `alm_asset` would also run on every query of its child tables. Its row check removes other Stockrooms'
  fleet assets, so such a list can show "removed by security constraints" gaps. The app's lists and forms use
  `alm_hardware`.
- A user with no NaaS role, such as the service desk, an IT asset manager or a Customer Service agent working a case
  about a failed fleet asset, reads hardware, fleet assets included, as the platform's ACLs allow. The app restricts
  only the users it scopes, and grants fleet assets only to its own roles.
- The ACL records that sat on `alm_hardware` keep their keys, so an install moves them to `alm_asset` rather than
  leaving them in place.
- A server script's GlideRecord is not checked by ACLs. A read the app makes for a restricted user and returns to them,
  if it has `^NQ` clauses, carries the user's filter in each clause itself: the customer page's equipment
  (`customerEquipmentQuery` ANDs the reader's `visibilityFilter` into each stage's clause).
- What only an instance can confirm (a Deny-Unless ACL with no role and a module function as its script, on a parent
  table, applying to its child table's records; *Applies To* on `alm_asset`; the row check on a New form) is on the
  first-install checklist.
