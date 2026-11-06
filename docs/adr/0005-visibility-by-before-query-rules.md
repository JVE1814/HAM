# Visibility enforced by before-query rules on indexed fields

Inventory techs only see their assigned Stockrooms; Customer admins and Site contacts only see their
Customer (and Site contacts only their Sites). This is enforced by before-query business rules that
add indexed filters, backed by ACLs. ACL-only row filtering at 100k–1M Assets produces slow lists and
"rows removed by security constraints" gaps. Provider staff other than inventory techs see all
Customers; per-account-team scoping is deliberately left out until a contract demands it.
