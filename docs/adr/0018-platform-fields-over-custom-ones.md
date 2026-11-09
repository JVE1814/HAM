# Platform fields over custom ones

Where the platform already has a field or a table for something, the app uses it and keeps none of its own
(ADR 0001; a Model's milestones, ADR 0017). The columns and the table below duplicated one; each was checked on a
Brazil instance without Hardware Asset Management Professional (2026-11-09).

## Replaced

- **An inventory tech's Stockrooms**: the table `x_daas_ham_stockroom_member` (user, stockroom) is gone. A
  Stockroom has the platform's *Assignment group* (`alm_stockroom.assignment_group`), and a tech works at the NaaS
  stockrooms whose Assignment group they are a member of (`sys_user_grmember`), read once per user and
  transaction as before (`platform/session.ts`, ADR 0005). The platform's ACLs decide who maintains it: a
  Stockroom's group takes `inventory_admin`, a group's members `user_admin`. A script of the app's scope may add a
  member but not create a group (`sys_user_group` lets other scopes read only), so the demo data ships its group as
  a record. Parent groups are not followed.
- **A Model's typical power**: `cmdb_model.x_daas_ham_typical_power_w` is gone. The rack power budget reads the
  platform's *Power (watts)* (`cmdb_model.power_consumption`), which the Provider's IT may already have filled.

## Consequences

- **Upgrades**: the build carries no delete for a removed table or column, so an instance that had an earlier
  version keeps them with their values, unread. Nothing is migrated: stockroom members are entered again as group
  members (README, *Verify on the first install*).
