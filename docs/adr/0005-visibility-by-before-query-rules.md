# Visibility enforced by before-query rules on indexed fields

Inventory techs only see their assigned Stockrooms; Customer admins and Site contacts only see their
Customer (and Site contacts only their Sites). This is enforced by before-query business rules that
add indexed filters, backed by ACLs. ACL-only row filtering at 100k–1M Assets produces slow lists and
"rows removed by security constraints" gaps. Provider staff other than inventory techs see all
Customers; per-account-team scoping is deliberately left out until a contract demands it.

For inventory techs the rules only narrow rows. They filter the tables that carry a Stockroom: stock,
Stockrooms, transfer orders, Staging tasks, and Audits with their lines (a site audit has no Stockroom,
so it drops out). The other tables of their work, such as Orders, Shipments and Return orders, serve
every Customer and are not narrowed. Tables inventory techs may not read at all (the customer,
commercial and configuration tables) are closed by the read ACLs' role lists, not by a match-nothing
filter: a before-query rule also applies to the server logic the user's actions set off. Receiving a
returned Asset, for example, reads and can end its Subscription line and record a late-return Fee
event. Server logic that must count past the user's rules, such as the units of a site package still at
the Site, queries with business rules off.

For Customer contacts, a rule on a table with no Customer field (or no Site field, for Site contacts)
matches nothing. Site contacts therefore get no Stockrooms, Agreements, subscription lines, catalog
entries or Fee events, and no Customer contact gets transfer orders or Staging tasks.
