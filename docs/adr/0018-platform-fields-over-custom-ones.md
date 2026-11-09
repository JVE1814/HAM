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
- **Track as asset**: `cmdb_model.x_daas_ham_track_as_asset`, which no code read, is gone. Whether a Model's units
  are tracked one by one is the platform's *Asset tracking strategy* (`cmdb_model.asset_tracking_strategy`: leave to
  category, track as consumable, do not track). The cross-scope privileges on `alm_consumable` and
  `std_change_record_producer`, which nothing used either, went with it.
- **The record on-site work belongs to**: `wm_order` and `change_request` each carried three references
  (`x_daas_ham_order`, `x_daas_ham_return_order`, `x_daas_ham_audit`) naming the Order, Return order or Audit the
  work is for, one of them filled. All three are tasks, and the platform has a reference to a task on both: a work
  order's *Initiated from* (`sm_order.initiated_from`) and a change's *Parent* (`task.parent`; the work order's own
  Parent stays its change). The app's rules on `wm_order` act on a work order initiated from an Order, testing that
  task's class. On a Brazil instance the only platform rule that reads *Initiated from* is a date check on
  `sm_task` that reads a crew's, and the only one on a task's *Parent* runs the parent's workflows, of which an
  Order, a Return order and an Audit have none.

## Consequences

- **Upgrades**: the build carries no delete for a removed table or column, so an instance that had an earlier
  version keeps them with their values, unread. Nothing is migrated: stockroom members are entered again as group
  members, and a Model's *Power (watts)*, a lease's *Vendor* and *Contract number* and an open work order's
  *Initiated from* are filled in again (README, *Verify on the first install*).
- **`change_request` carries no column of the app any more.** For a table whose last app column goes, the build
  carries a delete of the table label SDK 4.14 wrote for it, under the app's own sys_id; the platform kept its own
  label then and should now (to confirm on the first install: README).
- **Labels**: a lease's form and list read *Vendor* and *Contract number*, the platform's labels, where they read
  *Lessor* and *Schedule number*. The Contract number holds 40 characters (the schedule number held 60) and is
  required; the Vendor picker offers companies marked as vendors only.
