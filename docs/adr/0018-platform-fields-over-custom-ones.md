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
- **A lease's Lessor and schedule number**: `x_daas_ham_lease_schedule.lessor` and `.schedule_number` are gone. A
  Lease schedule is a contract (`ast_contract`), which has a *Vendor* (a company marked as a vendor) and the
  *Contract number* the vendor gives it; both are required of a lease. The platform shows a reference to a contract
  by its Contract number, so the override that made a lease's own *Number* its display value, needed only while a
  lease left the Contract number empty, is gone too. The app's messages still name a lease by its *Number*.
- **An Asset's Lessor**: `alm_hardware.x_daas_ham_lessor`, a copy of its lease's Lessor that a rule stamped and no
  logic read, is gone. An Asset's Lessor is its Lease schedule's Vendor (`x_daas_ham_lease.vendor`); its *Legal
  owner* still says that a Lessor owns it.

## Consequences

- **Upgrades**: the build carries no delete for a removed table or column, so an instance that had an earlier
  version keeps them with their values, unread. Nothing is migrated: stockroom members are entered again as group
  members, and a Model's *Power (watts)* and a lease's *Vendor* and *Contract number* are filled in again (README,
  *Verify on the first install*).
- **Labels**: a lease's form and list read *Vendor* and *Contract number*, the platform's labels, where they read
  *Lessor* and *Schedule number*. The Contract number holds 40 characters (the schedule number held 60) and is
  required; the Vendor picker offers companies marked as vendors only.
