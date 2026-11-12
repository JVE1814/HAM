# Verify on an instance

The vendor and platform contracts were checked against primary documentation
([external-contracts.md](research/external-contracts.md)) and the code follows it. What remains can
only be confirmed on an instance or behind a vendor login, and is listed here by area. Work through
it on the first install, and again after upgrading an instance where an earlier version was
installed: the checks marked **After an upgrade** apply only there, and some of them are clean-up
steps.

A check that names a user with one NaaS role (an *inventory-tech-only user*, say) means
impersonating a user who holds that role and no other NaaS role.

1. [Install and platform data](#install-and-platform-data)
2. [Fleet](#fleet-adr-0016)
3. [Access and visibility](#access-and-visibility-adr-0005)
4. [Rules and form buttons](#rules-and-form-buttons)
5. [Orders and transfers](#orders-and-transfers)
6. [Job locks](#job-locks-adr-0013)
7. [Returns, coverage and billing](#returns-coverage-and-billing)
8. [Racks](#racks)
9. [Vendor contracts](#vendor-contracts)

## Install and platform data

### Install log

*System Applications > Application install history* (`sys_upgrade_history_log`) lists one *Skipped
Error* row per global table the app adds columns to (`sys_documentation_<table>__en`; the tables are
the `Table({ augments })` records of `src/fluent/shared/platform-tables.now.ts`): SDK 4.14 writes a
table label for each augmented table, and the platform keeps the table's
own. The development instance's install of 2026-11-09, of the earlier version, which also added
columns to `change_request`, logged one per table it augmented and no other.

The app no longer adds a column to `change_request` (ADR 0018), so the build now carries two
deletes for records it used to write there, under the app's own sys_ids: the table label
(`sys_documentation_change_request__en`) and its licensing row
(`ua_table_licensing_config_369e4a1bcfc54fb38605149dc901ed02`). On an instance that never had them,
each is a *Skipped Error* row too, so a fresh install logs one row per augmented table, those two,
and no other. Any other *Skipped
Error* row is a defect. After the install, check that the *Change Request* table still has its
label (*System Definition > Tables*) and its licensing row. A fresh install on a Brazil PDI on
2026-11-11 logged exactly those rows, and *Change Request* kept both.

### Preflight check

Run the on-demand job **NaaS - preflight check** (*System Definition > Scheduled Jobs*). Its row
`preflight` in *NaaS Asset Management > Administration > Background jobs* reads *All prerequisites
present*, as on the development instance on 2026-11-09. Otherwise it reads *N prerequisite(s)
missing* and names them, each also logged as an error.

### Choices

The instance accepts the app's `alm_asset.substatus` choice set (v2 format, one value per `choice`
entry of `STAGE_FIELDS` in
`src/server/domain/vocabulary.ts`).
That format deletes only the app's own values, so the platform's stay beside them: after the install
of 2026-11-09, `sys_choice name=alm_asset^element=substatus^language=en` listed the platform's 45
rows on the
development instance (Brazil) and one for each of the app's values. Check that the out-of-box values
are still
there, e.g. `value=available` (In stock): the app's install never removes them, but a script that
deletes this field's choices takes them along, and only a reinstall from the platform's own choice
set brings them back. A Brazil instance already has *Pending evaluation* (`pending_evaluation`, In
stock) and *Lease return* (`lease_return`, Retired), so the app ships neither and its stages use
those values; on an older release check that both exist.

### Cross-scope access

The privileges in `shared/cross-scope.now.ts` match the scopes the instance reports
(`alm_hardware`, `change_request`, `wm_order`, `proc_po`, `sys_attachment`, ...), including delete
on `alm_transfer_order` and its lines, which sourcing uses to remove a transfer order created only
in part (otherwise the line's sourcing summary names it for cancelling). Procurement lets no other
scope delete a purchase order (its table's application access), so a purchase order created
without its line item is cancelled instead ([Purchase orders](#purchase-orders)).

### Running ATF

Tests with form steps run in a browser: a scheduled or CI/CD run (`now-sdk cicd testsuite run`)
needs a *Scheduled Client Test Runner* page (*Automated Test Framework > Run > Scheduled Client
Test Runner*) open, and every run needs the system property `sn_atf.runner.enabled` true (it is
false by default, so tests do not run on production). For test authors: a *Record Validation* step
checks the record loaded in memory, not the database, and compares a date field with `=` in the
session time zone. The development instance runs in America/Los_Angeles, where a stored 2028-01-31
matches only `ends=2028-02-01`. Check a date with a *Record Query* step, or with an `ON` range,
which matches in every time zone:

```text
endsON2028-01-31@javascript:gs.dateGenerate('2028-01-31','start')@javascript:gs.dateGenerate('2028-01-31','end')
```

### ATF route tests

Suites *NaaS - P1*, *P2* and *P3*. The tests of the customer returns, warehouse and audit scan
routes call each route's handler from a *Run Server Side Script* step, as the
impersonated user, with `require('x_daas_ham/naas-ham/<version>/src/server/entry/<file>.ts')`.
ATF's inbound REST step signs in through a basic auth profile, which the app's scope may not
create. Confirm that these steps run (no *require is not defined* or *No module with path*).
Confirm that *NaaS - the tracking webhook needs its token and records a delivery once* gets HTTP 401
*bad token* from its unauthenticated REST step. Confirm that its script step's two unauthenticated
posts with the token are each answered HTTP 200 *delivered*: the route runs as guest, so this shows
that `gs.getProperty` returns the scoped password2 token to guest despite its admin read role
(external-contracts.md N45). Where `x_daas_ham.shipping.webhook_token` was empty before the run,
confirm it is empty again after. The scripts spell out their modules' installed path, which names
the version in `package.json`: after a build, `src/server/built-metadata.test.ts` fails when the
version changes, until the paths are updated to match.

### Model lifecycle

ADR 0017; the platform's table and its rules were read on a Brazil instance, the app's use of it was
not run there. A lifecycle import row for a NaaS Model stores one active row per milestone in
`cmdb_model_lifecycle` (class *Hardware Model Lifecycle*, type *Publisher*, source *Internal*, the
provenance as its description), stamps the Model's fleet assets with their Lifecycle phase, and
queues `x_daas_ham.model.lifecycle` once; loaded again, it saves nothing. A milestone an asset
manager changes in *Model lifecycle* stamps them again, and one of a Model without an OEM PID queues
nothing.

**After an upgrade** from a version that had `x_daas_ham_model_lifecycle`, check that the table is
still there with its rows (the build deletes its ACLs, form, list and labels, not the table). The
app no longer reads them: load them again through the lifecycle import or enter them by hand.

### Platform fields

**After an upgrade** from a version that had the app's own columns (ADR 0018): the old columns stay,
unread. Fill in each lease's *Vendor* (its Lessor) and *Contract number* (until then a reference to
the lease shows blank, and its return-to-lessor disposal order gets no vendor) and each racked
Model's *Power (watts)* (until then it counts as 0 W in a rack's power budget). A work order opened
by the earlier version has no *Initiated from*: set it to the Order, Return order or Audit its old
column names (`x_daas_ham_order`, `x_daas_ham_return_order`, `x_daas_ham_audit`). Do it on every such
work order still open, or closing one for an Order will not confirm the install and its planned
start is not checked against the change window (*Confirm installed* on the Order does the former).
Do it as well on every one closed in a month whose Margin is still to be computed or computed
again: Margin takes a work order's labour in the currency of the Agreement its Order or Return
order names, and without one it takes the currency the Customer's Agreements share, so a Customer
whose Agreements bill in two currencies gets the labour left out with *no currency*. Stockroom
members are entered again as group members ([Stockroom assignment](#stockroom-assignment)).

An Asset's old *Lessor* column (`alm_hardware.x_daas_ham_lessor`) keeps its values, and no ACL of
the app keeps it to provider staff, so a Customer contact who reads an Asset can
read its Lessor (the Table API with `sysparm_fields=x_daas_ham_lessor`, for one). Clear it on every
Asset (list `alm_hardware` with `x_daas_ham_lessorISNOTEMPTY` and blank it), or delete the column,
then check that the list is empty.

### Procurement and FSM data

The stored `proc_po` / `proc_po_item` status values and column names, `wm_order` state 3 = Closed
Complete, and `last_discovered` / `discovery_source` as your connectors write them.

### Purchase orders

`platform/procurement.ts`. Procurement's business rule *Model Category of Model not empty* refuses a
purchase order line item whose Model has no *Model category* (`cmdb_model_category`; the
out-of-box *Network Gear* has asset class `alm_hardware` and CI class `cmdb_ci_netgear`). So the
app requests no purchase order for such a Model: sourcing a line for it leaves the line awaiting
stock with the sourcing summary *(no purchase order: give Model <name> a Model category: Procurement
refuses a line item without one)*, the spare-pool top-up buys nothing for it, and each logs
*[x_daas_ham] No purchase order (...)*. A purchase order whose line item Procurement refuses for
another reason is set to *Canceled*, and the reason says so (*... without its line item (...); it
is cancelled*), or says to cancel it when that save is refused too.

**After an upgrade.** NaaS Models saved before have no Model category unless someone gave them
one: list `cmdb_model` with `x_daas_ham_oem_pidISNOTEMPTY^cmdb_model_categoryISEMPTY` and set it
(e.g. *Network Gear*) before sourcing or the spare-pool top-up buys for them.

### Record names

The instance stores the name of a business rule, UI action, script action, email notification,
SLA definition, REST message and scripted REST API or route in a column of 40 characters, and cuts
a longer one off without a warning (scheduled scripts and properties: 100).
`src/server/built-metadata.test.ts` keeps every name in the built records within its limit. Check
that the rule list (`sys_script`, filter *Name starts with NaaS*) shows no name cut off.

### Long text on forms

The classic form draws a multi-line text field (`multi_two_lines`, Fluent `MultiLineTextColumn`) of
more than 255 characters as a bare hidden input with no field container and no label, and the
form's live update then throws *Cannot read properties of null (reading 'offsetParent')* when the
record watcher reports that field changed (development instance, 2026-11-09). So the long texts the
app writes are string columns, drawn as a text area in their container: on an off-catalog Order
open on the form, *Submit* writes its *Entitlement findings*, the form shows them under their
label, and the browser console shows no error. The same holds for a disposal line's *Blocked by*.

### Reference display

A table extending `ast_contract` inherits its display field, `vendor_contract` (*Contract number*),
which an Agreement leaves empty, so a reference to one would show blank. The Agreement overrides
`number` as its display field (`sys_dictionary_override` on `number` with *Display override* true):
a Subscription line's *Agreement* shows the Agreement's number (`NAG...`). A Lease schedule has no
such override (ADR 0018): its *Contract number* is mandatory, and an Asset's *Lease schedule* shows
it. On the development instance on 2026-11-09, on the earlier version, whose lease still overrode
`number`, the lease showed `NLS0001001` and an Agreement reference was blank, as
`agreements/tables.now.ts` then gave the Agreement no override. A lease's reference showing its
Contract number was not run on an instance.

### Scale

Before-query rule performance and the chunked jobs at your data volumes (indexes are declared on the
scoped columns). The *Job cursor* list (*Administration > Background jobs*; *Background job
cursors* in the workspace) shows how each scheduled pass ended: a *Last status* other than
*complete* (*complete with N failed record(s)*, or *paused (time budget), N failed record(s) so
far*) means records failed; *Failed (this pass)* and *Last error* say how many and the last error,
and each run logs them as an error in the system log. Some rows are no scheduled pass and read
differently: `preflight` holds the preflight check's result, `billing_generate_<period sys_id>` a
billing pass (ADR 0007), `provider_tag_sequence` the Provider tag counter, and `oem_claim_stranded`
only where the OEM claim run's check for stranded steps goes on from, with no status.

## Fleet (ADR 0016)

### Fleet column

*Fleet* (`x_daas_ham_fleet`) on `alm_hardware` is a read-only boolean, default false, with the
index `x_daas_ham_hw_fleet`, and the install sets it true on no row. The dictionary entries of
*Legal owner* (`alm_hardware`) and *Stockroom type* (`alm_stockroom`) have no default value, and
*Legal owner* offers *-- None --*: an Asset or Stockroom the Provider's IT creates on its form gets
neither.

### Add to fleet

Impersonating an asset-manager-only user, *Add to fleet* (form button and list choice) is offered
on an Asset outside the fleet and not on a fleet asset; an inventory tech is not offered it. On an
Asset *In stock / Available* in a NaaS stockroom whose Model has an OEM PID it says *<tag> added to
the fleet*: *Fleet* is set, a blank *Legal owner* becomes *Provider* (*Lessor* when its *Lease
schedule* is set), and its stage stays as it was. On one whose Model has no OEM PID, one in a
stockroom with no type, one reserved, or one in use without a Site and Agreement, it says *<tag>
not added to the fleet: <reason>* and the Asset stays outside the fleet. Adopting an Asset in
service opens no Service interval. On an Asset placed in a rack where it overlaps a fleet asset on
its face, or would take the rack over its power budget, it is refused with the placement's reason
and *<tag> not added to the fleet: ...*, and the Asset stays outside the fleet.

### Equipment outside the fleet is left alone

ADR 0016, ADR 0005. Take one of the Provider IT's Assets, outside the fleet and *In use* (a laptop).

- Rules: the lifecycle rule refuses no install status and substatus an asset manager without
  `admin` sets on its form, and the app neither checks nor follows up its *Lease schedule* or rack
  placement (its *Legal owner* stays as it is).
- Jobs: the daily reconciliation raises no *unseen* exception for it, and resolves one raised
  before the Fleet flag; refresh orders, the OEM coverage sync, the spare-pool top-up,
  attestations and billing pass it by.
- ACLs: a user with no NaaS role (the service desk) reads it as the platform's ACLs allow, and an
  inventory tech reads it as the platform allows whatever stockroom it is in.
- Lists and dashboards: the NaaS workspace lists and dashboard and the navigator's Asset modules
  do not count it, a case's *Failed asset* does not offer it (nor does any other Asset picker on
  the app's forms and catalog items), the warehouse app's Look up answers HTTP 404 *No fleet asset
  with that serial or tag*, and a device event naming it is reported in `unknown_identifiers`.

### Receiving outside the fleet

Warehouse app, ADR 0016. The stockroom list offers central depots and staging centres only, so a
Provider IT storeroom (no stockroom type) is not offered, and `POST /api/x_daas_ham/naas/receive`
(or `/putaway`) naming one answers HTTP 400 *Choose a NaaS stockroom: this one has no stockroom
type*. Scanning the serial of the laptop above, with or without a PID, answers HTTP 409 *Not
received: it is not a fleet asset: an asset manager adds it to the fleet first*, and no second
Asset is created for the serial. A unit Procurement created on order for a purchase order, outside
the fleet, is received and joins the fleet with the receipt when its Model has an OEM PID; when it
has none the scan answers HTTP 409 *Not received: its Model has no OEM PID: give the Model its OEM
PID first*.

### Fleet after an upgrade

**After an upgrade.** The install flags no Asset, so the NaaS units from before are outside the
fleet, and the app's rules, jobs, lists and dashboards pass them by until they are adopted. *Add to
fleet* (list choice) adopts those on order, in transit, available in a NaaS stockroom or in
service; running **NaaS - load demo data** again adopts the demo's. It refuses a unit in any other
stage, and the app has no other way in: an administrator sets *Fleet* on such a unit by script.

The earlier version's column defaults were also written on every row that existed when it was
installed, and on each one created since without a value, and they stay after the upgrade. On the
development instance, 9 of its 12 stockrooms were the platform's own IT warehouses stamped
*Central depot* this way. Clear them on the Provider IT's records:

- `alm_stockroom`, filter `x_daas_ham_stockroom_type=central_depot`: this list also holds the NaaS
  central depots (the demo's *Central Depot Utrecht* is one), so do not use *Update All*. Select
  the Provider IT's storerooms only and clear *Stockroom type* with *Update Selected*. Until then a
  Provider IT storeroom counts as a central depot: it is offered for receiving and a blind count,
  and an inventory tech who is not in its Assignment group does not see it. A NaaS depot cleared by
  mistake is no longer offered for receiving or a blind count, receiving there answers HTTP 400 and
  sourcing does not draw on its stock, until its type is set back to *Central depot*.
- `alm_hardware`, filter
  `x_daas_ham_fleet=false^ORx_daas_ham_fleetISEMPTY^x_daas_ham_legal_owner=provider`: clear *Legal
  owner* with *Update All*. A NaaS unit not yet adopted loses nothing: a blank Legal owner counts as
  the Provider's, and adoption sets it.

The earlier version's *Track as asset* default on `cmdb_model` needs no clean-up: the app no longer
has that column (ADR 0018), and it stays on the instance with its values, unread.

## Access and visibility (ADR 0005)

### Stockroom assignment

ADR 0018; the platform's columns, ACLs and table access were read on a Brazil instance, the app's
use of them was not run there. An inventory-tech-only user who is a member of a NaaS stockroom's
*Assignment group* sees that stockroom's fleet assets, staging tasks and blind counts and no other
NaaS stockroom's; taken out of the group, none. With demo data, the group *NaaS demo depot team* is
installed (a `sys_user_group` record in the app's demo data) and the demo job makes `naas.inventory`
its member and sets it on *Central Depot Utrecht* and *Staging Centre Utrecht*; if the system log
says the group was not found, create it by that name and run the job again.

**After an upgrade** from a version that had `x_daas_ham_stockroom_member`, the app no longer reads
its rows: give each NaaS stockroom an *Assignment group* holding its techs.

### Inventory tech access

Also after upgrading an existing install. The ACLs that each feature's `access.now.ts` gives `BROAD_STAFF`
(agreements, subscription lines, catalog entries, site templates, fee events, attestations, leases,
OEM coverage and cloud accounts, model data, device events, reconciliation exceptions, ...) no
longer list `x_daas_ham.inventory_tech` in `sys_security_acl_role`. Impersonating an
inventory-tech-only user, the Agreements list is denied, other stockrooms' blind counts and site
audits are not listed, and in the warehouse app receiving one returned unit of a multi-unit site
package keeps its subscription line active, receiving the last one ends it, and a late one records
the late-return fee. Impersonating a field-tech-only user, the warehouse app offers only Audit and
Look up, and `POST /api/x_daas_ham/naas/receive` (and `/putaway`, `/pick`, `GET /stockrooms`)
answers HTTP 403.

### Reads past the visibility rules

`platform/beyond-visibility.ts`. Impersonating an inventory-tech-only user assigned to one
stockroom, the Assets list shows that stockroom's fleet assets and no other stockroom's (beside the
Provider IT's hardware, as the platform's ACLs allow), yet in the warehouse app scanning the serial
of a unit in transit (in no stockroom yet) receives that Asset, not *Unknown serial: scan the PID
too ...*, an ASN row for a serial an Asset of another stockroom carries is marked error *serial
<serial> already exists*, Ship of an Order whose hot spare sits in the customer-site stockroom
ships the spare with the staged units, and placing an Asset in rack units a device at the Site
already fills (in none of the tech's stockrooms) is refused with the overlap reason.

### Hardware ACLs on `alm_asset`

`sys_security_acl` holds no record ACL (one with no field) of the app on `alm_hardware`; its field
ACLs there are on the app's own columns. The records keyed `acl_alm_hardware_read_staff` and
`acl_alm_hardware_read_customer` (`keys.ts`) name `alm_asset`, with *Applies To*
`sys_class_name=alm_hardware`, and **after an upgrade** they were moved there, not copied. Beside them, the row check keyed `acl_alm_asset_read_scope` is a Deny-Unless read ACL
with no role, whose script is a function of the app's module. A user with no NaaS role (the service
desk, an IT asset manager) reads hardware, fleet assets included, as the platform's ACLs allow,
except the app's Provider columns (support cost, claim code, lease), which only provider staff
read.

### Row checks

`shared/visibility.now.ts`. Impersonating an inventory-tech-only user assigned to one
stockroom, the list `alm_hardware_list.do?sysparm_query=sys_id=<fleet asset of another
stockroom>^NQsys_id=<fleet asset of theirs>` shows only their unit, with a *rows removed by
security constraints* gap: the Deny-Unless check on `alm_asset` applies to an `alm_hardware` record
that a query the rule does not narrow reaches. The same query on `alm_asset_list.do` shows the
same. Their `alm_asset` list shows consumables and licences as before the install (*Applies To*
keeps the app's ACLs off the other classes of Asset) and leaves out other stockrooms' fleet assets,
with such gaps (ADR 0005). A New form of an Audit or a Staging task opens.

### Changes to hardware by hand

ADR 0005, `fleet/access.now.ts`. Impersonating an inventory-tech-only user, a fleet asset
of their stockroom saves, but its company, cost, Agreement, subscription line, lease, Legal owner
and Fleet are read-only, the form offers no Delete, and `DELETE
/api/now/table/alm_hardware/<id>` is refused; a list edit of cost on `alm_asset_list.do` is refused
on a fleet row; a laptop outside the fleet saves, deletes and takes a new company and cost as
before. An asset manager changes a fleet asset's company and cost; only an app administrator
deletes one. A consumable's cost is still writable as before. Impersonating a Customer contact who
also holds `sn_customerservice.customer`, `GET /api/now/table/alm_hardware/<their fleet asset>`
returns no cost, support cost, claim code or lease, and a Shipment returns no cost.

### Work order labour cost

`margin/margin.now.ts`. Impersonating a field-tech-only user, a work order with a *NaaS purpose*
saves as before (state, work notes), and `PATCH /api/now/table/wm_order/<id>` with
`{"x_daas_ham_labour_cost":"180"}` does not change its *NaaS field labour cost*. An asset manager
or a finance user changes it the same way. A user with no NaaS role who reads the work order (a
dispatcher of the Provider IT) gets no `x_daas_ham_labour_cost` from `GET
/api/now/table/wm_order/<id>?sysparm_fields=number,x_daas_ham_labour_cost`. Closing the month's
billing period afterwards still writes the *Field labour* Cost fact from the cost entered.

### Customer creates

`orders/access.now.ts`, `returns/access.now.ts`. As a customer admin, `POST /api/now/table/x_daas_ham_order` for another
Customer and `POST /api/now/table/x_daas_ham_order_line` are refused; a `POST` of a Return order
for another Customer is refused (this confirms the create rule sees the posted values); the
customer page's *Return selected* and the two record producers still work. As a service desk
agent (`sn_customerservice_agent` only), the order producer offers the Customer's Agreements and
Site templates, the generated Order opens with its lines and *Submit* goes ahead, and the return
producer opens the Return it raised.

### REST access for customer users

`shared/rest-api.now.ts`. In *System Web Services > Scripted REST APIs >
NaaS asset management*, the routes `/sites`, `/racks`, `/racks/{id}` and the `/customer/...`
routes have *Requires SNC Internal role* off and the ACLs *Scripted REST External Default* and
*x_daas_ham NaaS customer routes*. The latter is an execute REST_Endpoint ACL with the roles
`x_daas_ham.customer_admin` and `x_daas_ham.site_contact`. Every other authenticated route keeps
*Requires SNC Internal role* on and the default ACL alone. `/shipping/tracking` has
authentication, ACL authorization and *Requires SNC Internal role* off. Impersonating *Ada Acme
(demo)*, `x_daas_ham_customer.do` lists the Customer's equipment and `x_daas_ham_racks.do` lists
their Sites and racks. Impersonating *Sam Site (demo)*, both pages show only their Sites. As either
user, `GET /api/x_daas_ham/naas/stockrooms` and `/billing_periods` answer HTTP 403.

### NaaS Asset Workspace

`x_daas_ham_workspace.do` (src/client/workspace). It opens for each NaaS staff role
(`PROVIDER_STAFF` in `src/server/domain/roles.ts`) and for app administrators, and for no
Customer contact (the page's ACL). Its sidebar offers a role only the lists of its audience
(`catalog.ts`), and each list shows what the table's ACLs and before-query rules let the user
read. As a NOC-only or inventory-tech-only user, Operations,
Billing integrity and Lifecycle risk show counts and the Margin tab is not offered; an inventory
tech is not offered the subscription-line and reconciliation-exception tiles. As finance, the Margin tab
shows figures, each in its own currency. As a non-admin staff user, *Overdue returns*, *Agreements
up for renewal* and the Margin tiles (`javascript:gs.…` dates in the query) and *My staging tasks*
(`assigned_toDYNAMIC`) show rows, and every list has its column labels (`/api/now/ui/meta`).

**After an upgrade** from a version with the Next Experience workspace (`/x/daas/naas-assets/home`):
the build carries a delete for each of its records (`dist/app/author_elective_update`). Check that
the *NaaS Asset Workspace* experience, its list menu with its lists, categories and audiences, the
*NaaS Asset Overview* dashboard and the `x.daas.naas-assets.*` route ACL are gone.

## Rules and form buttons

### Refusals on `alm_hardware` and `wm_order`

The rules' Abort action. A user without `admin` who sets a fleet asset's install status and
substatus on the form to a move the lifecycle does not allow (*Available* to *In use*, say) or to a
combination the app does not model gets the reason as an error, and the Asset keeps its stage; an
administrator's same save is written. A save into staging clears *Wiped on* and *Wipe
certificate*, an administrator's too. Moving the planned start of a NaaS Order's work order outside
its change window on the form is refused with *The work must be scheduled inside the change
window*. A save by script that these rules refuse returns no sys_id, and its last error names the
rule (*Operation against file 'alm_hardware' was aborted by Business Rule ...*), not the reason
(external-contracts N36).

### Re-check approvals

Order form, next to *Submit*, *Ship*, *Confirm installed* and *Cancel order*. Its condition, an
inline `sysapproval_approver` query kept under the 254-character condition limit, shows the button
only on an Order awaiting approval with no requested approval.

### Confirm installed

Order form. Its condition, an inline `alm_hardware` query (substatus `shipped_to_site`) kept under
the 254-character limit, shows the button on an Order installing, or on one with shipped units
(back in preparing or delivering after a unit was lost in transit), to holders of the platform
`asset` role (asset managers, field techs), and to Customer contacts only on self-install Orders.
Check that a site contact sees it on a self-install Order back in preparing with one shipped unit,
and that confirming moves only that unit.

## Orders and transfers

### Order create rule in jobs

An Order is submitted only when its user passes the Order create rule (`GlideRecord.canCreate()`).
The daily job *NaaS - raise refresh orders* relies on its *Run as* user (expected to be the system
user) passing it; one without an Order raiser role leaves its refresh Orders as drafts with the
work note *You may not raise orders*.

### On-site work links

ADR 0018; not run on an instance. Shipping an Order with an engineer install opens a change whose
*Parent* is the Order and a work order whose *Initiated from* is the Order and whose *Parent* is the
change; closing that work order complete confirms the install. A work order the Provider's IT
initiated from another task (an incident, say) is left alone: closing it runs nothing of the app's,
and its planned dates are not checked.

### Units that leave in transit

Order lines. A shipped unit of an Order moved to missing or pending return (a device removal) logs
*[x_daas_ham] <serial> left <line> in transit (<stage>): taken off the line, which is filled again*
(info), followed by a queued `x_daas_ham.order.source` pass. The after rule's nested Asset save
that clears `x_daas_ham_order_line` runs no stage rules and keeps the outer save's stage. A nested
save the platform refuses logs *[x_daas_ham] <serial> left <line> in transit (<stage>) but stays on
it, which is not sourced again: <reason>* (warning), and a line that cannot be saved back to
awaiting stock logs *[x_daas_ham] <line> lost a unit in transit but is not sourced again*
(warning).

### Transfer orders

ADR 0002, external-contracts N38, N39. Impersonating an inventory-tech-only user, work through its
tasks a transfer order sourcing raised (an Order line filled from stock outside the staging
centre). Each unit's history shows it handed over *In stock / Available* just before its line was
inserted, and Inventory then putting it *In stock / Pending transfer* with *Active transfer order*
set: the Asset is *In transfer*, its Staging task is open and its Order line counts it as sourced.
A blind count started in the stockroom it leaves expects it. Closing the tasks to *Requested*,
*Shipment Preparation* and *In Transit* (*In transit / Reserved*) is not refused. Receiving the
line at the staging centre leaves the unit *In stock / Staging* there, not *Available*, with the
flag and its wipe evidence cleared, and its Staging task can be finished. Cancelling another such
line before it is received puts its unit back as free stock (*Available*, under the Provider
company) in the stockroom it was sent from, skips its Staging task, sources its Order again and
logs *[x_daas_ham] <serial> left its transfer to the staging centre in <stockroom>: put back as
free stock, its line sourced again* (warning).

### Transfer refusals

ADR 0002; ATF cannot check them, as the lifecycle rule checks interactive saves only. As a user
without `admin`, setting *In stock / Pending transfer* on the form of an available fleet asset on
no open line is refused with *An asset is in transfer only while it is on an open transfer order
line*, and setting *In stock / Available* on one whose line is open with *An asset leaves transfer
only once Inventory lets it go from its transfer order line*. *Cancel order* takes a unit in
transfer off its Order line and leaves it in transfer; once Inventory lets it go, it is
*Available*. A line received after its last task was closed skipped leaves its Asset in transfer
with the flag cleared, and its stage can then be set on the form.

## Job locks (ADR 0013)

### How a job lock behaves

A job lock is a row in *Job lock* (`x_daas_ham_job_lock`) named after what it guards, such as
`receive_asset_<Asset sys_id>`: taking it is one insert, and letting it go deletes the row. Check
once that *Job lock* shows a unique database index on *Lock*, and that a second row with the same
name is refused (`GlideRecord.insert()` returns no sys_id) without throwing.

Every lock below behaves as follows, which its own check does not repeat:

- **Errors in the system log.** A take tries the insert, clears the lock if it is abandoned, and
  tries again, so a take that finds the lock held logs two *Unique Key violation* errors. When the
  holder lets go between the second try and the check that follows, the take tries a third insert:
  three errors are logged when another take wins it, and a third try that is accepted takes the
  lock. A step that tries its lock *n* times in a row logs up to 2*n* errors when it is held
  through all of them.
- **Holding a lock by hand.** A row created by hand in *Job lock* with the lock's name (the sys_ids
  it names filled in) holds the lock, as another run would. Delete the row and the next run, event,
  scan or press goes ahead.
- **Abandoned locks.** A row created longer ago than `ABANDONED_AFTER_MINUTES` is taken as abandoned
  (`src/server/domain/job-lock.ts` owns that time and the try and re-queue counts below) and cleared
  by the
  next take, which then goes ahead; a fresh one is not cleared.
- **Nothing left behind.** No lock row is left once the run, request or action that took it ends.

### Margin recompute lock

`margin_<Billing period sys_id>` ([how a job lock behaves](#how-a-job-lock-behaves)). The
`x_daas_ham.margin.compute` event still ends as processed when its take is refused. A chunk that
finds the lock held runs again `REQUEUE.delaySeconds` seconds later. A recompute whose lock was
cleared while it
was writing logs a *job lock lost while writing* warning and starts a fresh pass, which recomputes
the period from scratch. A recompute whose clearing of the period's old Cost facts or Margin rows
leaves a row (kept by a delete rule, say) stops with *Last margin error* *stopped: old Cost facts
not all removed* (or *old Margin rows not all removed*) and logs *[x_daas_ham] Margin of <period>
stopped: ...*.

### Provider tag counter

Warehouse Receive ([how a job lock behaves](#how-a-job-lock-behaves)). The counter is advanced
under the job lock `provider_tag_sequence`, so two units received at the same moment get different
tags. A number whose tag an Asset already carries is skipped, so a counter set back (by a holder
that outlasted the lock) skips the tags issued since; only a tag issued but not yet saved on its
Asset when such a write lands could be issued again (ADR 0013). With *Cursor* of the
`provider_tag_sequence` row in *Job cursor* set to 0, the next unit received gets the first tag no
Asset carries. A receipt that finds the lock held `LOCK_TRIES` times in a row answers HTTP 503
*Other receipts
are taking Provider tags: scan again* and leaves the unit unreceived (two *Unique Key
violation* errors a try for one 503).

### Serial lock

Warehouse Receive without an ASN, and ASN import rows
([how a job lock behaves](#how-a-job-lock-behaves)). The first scan of an unknown serial with its
PID, or an ASN row, creates the Asset under the job lock `receive_serial_<serial>`, checking there
that no Asset has the serial, so two first scans, or a scan and an ASN row, create one Asset. The
other scan answers HTTP 503 *Another scan is receiving this unit: scan again*; its rescan finds the
Asset by serial. An ASN row tries the lock `LOCK_TRIES` times: with a row `receive_serial_<serial>`
created by
hand, an ASN row loaded for that serial is marked error *serial <serial> not imported: a scan or
another row is receiving it; load this row again*, and two *Unique Key violation* errors a try are
logged.

### Receipt lock

Warehouse Receive and the overdue job ([how a job lock behaves](#how-a-job-lock-behaves)). A receipt
holds the job lock `receive_asset_<Asset sys_id>` and re-reads the Asset under it. When one unit is
scanned on two devices at once, one receives it. The other answers HTTP 503 *Another scan is
receiving this unit: scan again*. A scan that meets the holder letting go between its first and
second try logs one *Unique Key violation* error and answers HTTP 409 *Not awaiting receipt*. The
overdue job takes the same lock to declare a unit missing: one that finds it held leaves the unit
to the scan and its line to the next day's run.

### Stock reservation lock

Order sourcing, the spare-pool top-up, receiving's reservation for a waiting line, put-away and a
lease return's withdrawal ([how a job lock behaves](#how-a-job-lock-behaves)). Reserving an Asset
for an Order line, linking a hot spare at the customer site to one, or moving free stock into a
Spare pool takes the job lock `reserve_asset_<Asset sys_id>` and re-reads the Asset under it, so
two runs that pick the same Asset never both claim it. Put-away and the withdrawal of a returned
lease's stock take the same lock, each trying `LOCK_TRIES` times, so neither moves a unit a claim is
taking.
The re-read also refuses a unit whose lease is being returned to its Lessor (end action *Return to
lessor*), so such a unit is never reserved, linked or pooled.

- A run that finds the lock held leaves that Asset (the unit counts in its line's or pool's
  shortfall). When the holder lets go between its first and second try, the run logs only one
  *Unique Key violation* error, and its re-read finds the Asset taken. The holder may also be a
  put-away or a withdrawal, which leaves the unit free stock: the run still leaves it and counts it
  short, so a sourcing pass may buy for it.
- A lock that cannot be taken for another reason logs *[x_daas_ham] Asset <id> not claimed: job
  lock ... could not be taken*, or *[x_daas_ham] Asset <id> not put away: job lock ... could not be
  taken* for a put-away, or *[x_daas_ham] Asset <id> not withdrawn for its lessor: ...* for a
  withdrawal. A withdrawal held off through its tries, or whose lock cannot be taken, logs
  *[x_daas_ham] Lease return: <serial> not withdrawn: its stock lock could not be taken*.
- A claim that outlasts its lock and gives the Asset up logs *[x_daas_ham] Asset <id> not claimed:
  its lock was lost while claiming it*.
- A receipt whose reservation finds the unit taken logs *[x_daas_ham] Received <serial> not
  reserved for <line>: another run claimed it, or the save was refused*; that also covers a
  reservation that met a put-away or withdrawal holding the lock. A receipt whose line, read again
  under its lock, no longer awaits stock or has all its units logs *[x_daas_ham] Received <serial>
  left in stock, not given to <line>: ...* and leaves the unit free stock.

### Sourcing locks

Order sourcing and receiving ([how a job lock behaves](#how-a-job-lock-behaves)). A sourcing pass
holds the job lock `source_order_<Order sys_id>` for its whole run, and reads and saves each line
under `order_line_<line sys_id>`, which a receipt for a waiting line takes too.

- A pass that finds the Order's lock held logs *[x_daas_ham] <Order> sourced again in <n> s: another
  pass or a cancel holds its lock* (info), and runs again `REQUEUE.delaySeconds` seconds later. A
  request queued again
  `REQUEUE.times` times logs *[x_daas_ham] <Order> not sourced again after <n> tries (...): check
  its lines*
  (warning) and is dropped.
- A line lock is tried `LONG_HOLD_LOCK_TRIES` times (two errors a try). Held through them all,
  sourcing leaves the line
  to the pass queued again (after picking stock, it logs *[x_daas_ham] <line> left to the next
  sourcing pass (...)*, naming any transfer orders the line does not list), and a receipt answers
  HTTP 503 *Its order line is being sourced, received or cancelled: scan again* and saves nothing. A received
  unit whose reservation fails queues `x_daas_ham.order.source` for its Order: one *not reserved
  for <line>* warning is followed by a sourcing pass, not by a stalled line.
- *Cancel order* takes `source_order_<Order sys_id>` too: with a row of that name in *Job lock*, it
  says *Order not cancelled: it is being submitted or sourced. Try again in a minute* and changes
  nothing. *Submit* takes it as well: with that row in place, it says *Order not submitted: it is
  being cancelled. Try again shortly* and the Order stays a draft.
  Under it, it also takes `ship_order_<Order sys_id>`: with a row of that name in place (and none
  for `source_order_`), it says *Order not cancelled: a Ship of the Order is running. Try again once
  it is done* and changes nothing.

### Sighting lock

Device events and in-service detection ([how a job lock behaves](#how-a-job-lock-behaves)). An NMS
event or the detection job applies a sighting under the job lock `seen_asset_<Asset
sys_id>`. With a row named `seen_asset_<sys_id of a pending-in-service Asset>` in *Job lock*, POST a
*seen* event for it. The POST answers `202` with its identifier in `busy_identifiers` and
`accepted` 0, after `LONG_HOLD_LOCK_TRIES` refused tries (two *Unique Key violation* errors each).
The detection
job leaves that Asset pending and logs nothing of its own for it: only the *Unique Key violation*
errors of its refused tries appear. Delete the row and the next event or run puts it in service.

A go-live starts a pending Subscription line under `subscription_line_<line sys_id>`. With a row of
that name in *Job lock*, a *seen* event for an Asset going live on that line is accepted. The Asset
stays pending in service, two *Unique Key violation* errors a try are logged, and so is *[x_daas_ham]
<serial> stays pending in service, line not started: another go-live held its lock through every
try* (warning). Delete the row, or leave it until it is abandoned, and the next sighting starts the
line.

### Fee event and service interval locks

[How a job lock behaves](#how-a-job-lock-behaves). Charging a Fee event takes the job lock
`fee_<type>_<Asset sys_id>_<Return order sys_id>`, and opening or closing a Service interval takes
`service_interval_<Asset sys_id>`. In *Job lock*, create a row named `service_interval_<sys_id of a
pending-in-service Asset>`, then move that Asset into service: no Service interval opens, and the
system log shows two *Unique Key violation* errors a try and *[x_daas_ham] <serial> in service from
<date>, no interval open: left to another save holding its lock ...* (error). Delete the row and
the next go-live opens it. With the row in place, moving an Asset with an open interval out of
service leaves it open and logs *[x_daas_ham] <serial> left service on <date>, its Service interval
still open: ...* (error). A row named `fee_<type>_<Asset sys_id>_<Return order sys_id>` does the
same to a line declared missing or a damaged evaluation saved: it logs *[x_daas_ham] <type> fee for
<serial> not recorded: left to a run holding its lock ...* (warning) and records no fee.

### Refresh lock

Daily refresh Orders ([how a job lock behaves](#how-a-job-lock-behaves)). The daily *NaaS - raise
refresh orders* run holds the job lock `refresh_orders`. With a row of that name in *Job lock*,
*Execute now* raises nothing. It logs two *Unique Key violation* errors and *[x_daas_ham] Refresh
Orders not raised: another run holds the refresh_orders lock and raises them* (info). Delete the
row and the next run raises them.

### Spare-pool lock

Daily spare-pool top-up ([how a job lock behaves](#how-a-job-lock-behaves)). The *NaaS - spare pool
top-up* run counts, fills and buys for each short Spare pool under the job lock
`spare_pool_<Customer sys_id>_<Model sys_id>`. With a row of that name in *Job lock* for a pool
that is short, *Execute now* moves nothing into it and buys nothing for it. It tries `LOCK_TRIES`
times (two
*Unique Key violation* errors a try), and the run logs *[x_daas_ham] Spare pool of <Customer sys_id>
for <Model sys_id> not topped up: another run holds the spare_pool_... lock and tops it up* (info).
Delete the row and the next run tops it up.

### Return locks

Returns and the customer page ([how a job lock behaves](#how-a-job-lock-behaves)). Every Return puts
each unit on it under the job lock `return_asset_<Asset sys_id>`, and the customer page raises a
Customer's return requests under `return_request_<Customer sys_id>`. With a row named
`return_request_<Customer sys_id>` in *Job lock*, *Return selected* on the customer page answers
HTTP 503 *Another return request of yours is being raised: try again in a moment* and raises
nothing. Delete the row and the request raises the Return. Sending the same request again then
answers HTTP 409 *Each device is already on a return* and raises nothing. With a row named
`return_asset_<sys_id of an in-service Asset>`, a Return raised for that Asset (record producer or
customer page) tries the lock `LOCK_TRIES` times (two *Unique Key violation* errors a try), leaves
it off and,
as the Asset awaits no return, warns *[x_daas_ham] Asset <sys_id> left off return <number>: its
return lock was held through every try, yet it awaits no return: put it on one by hand if it is due
back*. A Return left with no unit closes at once, noting *No unit could be added (see the system
log).* The customer page then answers HTTP 422 *No device could be added: each is already on a
return or was refused*. Where another Return did take the unit, the line is info instead, ending
*another return held its lock and took it*, and a Return left with no unit notes *No equipment to
bring back.* On the customer page, a second click on *Return selected* while the first is on its way
sends nothing, a device pending return has no checkbox, and the selection clears once the Return is
raised.

### OEM claim run lock

OEM claims and provisioning ([how a job lock behaves](#how-a-job-lock-behaves)). The *NaaS - OEM
claim and provisioning* run holds the job lock `oem_claim_run` for the whole run. With a row of that
name in *Job lock*, *Execute now* sends nothing and logs *[x_daas_ham] OEM claims not sent: another
run holds the oem_claim_run lock and sends them* (info). Delete the row and the next run sends them.

### Return label, Ship and tracking locks

[How a job lock behaves](#how-a-job-lock-behaves).

- *Create return label* holds the job lock `return_label_<Return order sys_id>` while it checks for
  an open label and buys one. A second press while one is being bought says *A return label is
  already being bought for this return* and buys nothing.
- *Ship* holds `ship_order_<Order sys_id>`: a second Ship says *Another Ship of this Order is
  running* and ships, buys and opens nothing. *Cancel order* holds the same lock while it checks and
  releases the Order's lines; a Ship pressed then says the same.
- The tracking webhook holds `track_shipment_<Shipment sys_id>` while it saves the status and
  inserts new events, and *Mark label voided* while it checks and saves the void. A busy lock is
  retried inside the app, not by the aggregator. With a row of that name created by hand in *Job
  lock*, a delivery answers HTTP 202 `{"matched": true, "queued": true}` within a second, logs two
  *Unique Key violation* errors a try (`LOCK_TRIES` tries) and *[x_daas_ham] Tracking update of
  Shipment <number>
  (<tracking number>) queued in 1 event(s): another update held its lock* (info), and saves nothing
  yet. The `x_daas_ham.shipment.track` event then tries again as soon as it is processed and every
  `REQUEUE.delaySeconds` seconds after, each try logging its errors again and *... tried again in
  <n> s: another
  update held its lock*. Delete the row and the next try saves the status and events (and notes a
  delivery on the Order once); left in place, the first try once the row is older than
  `ABANDONED_AFTER_MINUTES` clears
  it as abandoned and saves them. A retry still held off after `REQUEUE.times` re-queues logs
  *[x_daas_ham]
  Tracking update of Shipment <number> (<tracking number>) dropped after <n> tries (...): check the
  Shipment with the carrier* (warning).
- With the `track_shipment_` row in place, *Mark label voided* says *Label <tracking number> not
  marked voided: a tracking update of it is being saved. Try again* and changes nothing. *Mark
  label voided* on an outbound label also holds `ship_order_<Order sys_id>`. With a row of that
  name in place, it says *Label <tracking number> not marked voided: a Ship of its Order, or a void
  of one of its labels, is running. Try again once it has finished* and changes nothing, and a Ship
  pressed while a void holds the lock says *Another Ship of this Order is running*.
- The queued update travels in the event's `parm1`, at most `TRACKING_RETRY_CHARS` characters
  (`src/server/domain/shipping.ts`; a long history is
  shared out over several events, never cut): check that `sysevent.parm1` holds that many on the
  instance (its dictionary max length), as that size comes from community answers, not ServiceNow's
  documentation. A longer value would be cut on save and the retry dropped as *parm1 is not an
  update*.

## Returns, coverage and billing

### Returns and site packages

When an Agreement with equipment at two Sites ends, the daily job raises one Return order per Site,
each with a normal change and a de-install work order located at that Site. A site package whose
last outstanding unit is declared missing ends that day. With every unit of a one-site package
swapped (a break-fix swap of a one-device package, for example), receiving the old units before the
new ones are seen leaves the package active, and returning or declaring missing the never-seen new
units then ends it.

**After an upgrade:**

- Site packages kept active by a unit declared missing before this release are not ended
  retroactively: list active site-package lines whose Site has no Asset under the Agreement
  shipped, pending in service, in service, temporary or pending return, and end them by hand.
- Agreements that ended before this release had their agreement-end Returns raised without the
  units still shipped to a Site: list Assets whose Agreement has *End-of-agreement return raised*
  set and which are shipped, pending in service, in service or temporary, and return them by hand
  (record producer, device removal).
- Lessor-owned units of a returned lease that were evaluated as refurbish before this release may
  still sit in available stock: sourcing no longer claims them, but they are not withdrawn. List
  available Assets whose lease's end action is *Return to lessor*, move them to pending wipe and
  put them on a *return to lessor* disposal order.
- The spare-pool top-up no longer counts spare-pool units of a returned lease as reserved spares,
  so its first run after the upgrade may move free stock into those Customers' pools (and buy for
  them when `x_daas_ham.spare_pool.auto_purchase` is true). Withdraw a returned lease's spare-pool
  units the same way.
- The spare-pool top-up now sizes one Spare pool per Customer and Model across all their
  Agreements, and nets the open top-up purchases described *Spare-pool top-up <Customer sys_id>:*.
  Purchase orders requested by an earlier run are described *Spare-pool top-up <Agreement
  sys_id>:* and are not netted. Cancel them, or let them be received, before the first run with
  `x_daas_ham.spare_pool.auto_purchase` true, or that run may buy their units again.
- Each fee type is now charged at most once per Asset and Return order. Before this release, a
  damage fee could be charged twice when an evaluation was chosen again after the lifecycle refused
  the move: list Fee events (not waived) that share type, Asset and Return order, and waive the
  duplicates.

### Replacement SLA stop

Completing a replacement Order queues the event `x_daas_ham.replacement.complete` on it. Its script
action *NaaS - note replacement on its case* runs as system, outside any interactive session, and
saves the case with the work note *Replacement order <number> is complete: the replacement is
installed.* Check this as a user without `sn_customerservice.case_admin` whose CSM query rules do
not grant them the case: an asset manager moving the replacement unit to in service on the Asset
form, and a customer contact using *Confirm installed* on a self-install replacement. In each case
the event is processed within seconds (*System Logs > Events*). The case gets the work note,
written by *system*. Its *NaaS replacement* Task SLA stops (stage *Completed*, not breached). No
*... its case ... was not found* or *... the case save was refused* warning is logged. Repeat once
through the device-events API or the in-service detection job.

### Meraki coverage

**After an upgrade.** Meraki Assets' coverage is now asked of Cisco SN2INFO only when both
`x_daas_ham.oem.meraki.enabled` and `x_daas_ham.oem.cisco.enabled` are true. An install that had
only Cisco enabled stops refreshing Meraki coverage until the Meraki property is turned on.

### Currency

Each Agreement bills in one currency: its *Currency* (`x_daas_ham_agreement.currency`, a
three-letter ISO code) is mandatory with no default in the dictionary, as is the Billing line's;
the Subscription line's own *Currency* is read-only, has no default and is not billed. An
Agreement's Billing lines and Cost facts are kept in its currency, a shipment's cost in the
carrier's. Period totals and Margin are kept per currency, and no two currencies are ever added:
with lines in EUR and USD, a period's *Totals per currency* reads `EUR <amount>; USD <amount>`, its
*Total (lines in one currency)* is blank, and its Margin has one row per Customer, Site and
currency.

**After an upgrade.** Agreements saved before have no currency: list `x_daas_ham_agreement` with
`currencyISEMPTY` and set it on each before the next Billing period is generated. Until then each
of their lines and fees fails to bill, counted on the period (*Lines that failed to bill*, with a
*Last generation error* ending *no currency: its Agreement <number> has no currency: set the
Agreement's currency*), and *Close period* refuses
until a *Regenerate* bills them. Running **NaaS - load demo data** again gives the demo Agreements
EUR.

The app's amounts are Decimal fields, which no session currency converts. An Asset's *Cost* is the
platform's currency field: Margin reads it (`getValue`) in the session currency of the user its
recompute runs as, and a lease buyout writes a plain number there, which the platform takes in
its user's session currency, while Margin keeps the purchase write-off in the Agreement's currency
without converting it. Confirm that this session currency is the Agreements' currency. With
Agreements in several currencies, the write-offs under those in another currency carry the
session currency's figures ([external-contracts](research/external-contracts.md), *`alm_asset.cost`
currency*).

## Racks

### Rack re-check

Q67. Two saves placing Assets into the same rack units at the same moment both pass the before
rule, and the after rule of the later one, reading the rack afresh, sees both and opens *Devices
overlap in rack* (or *Rack over power budget*) on the rack. Moving one device away resolves it. A
Model or rack capacity edit that clears it is resolved by the next daily reconciliation.

## Vendor contracts

### REST messages

That `${meraki_host}` / `${mist_host}` substitute inside the endpoint host (otherwise use
`setEndpoint`), that the GreenLake `find_device` filter URL is accepted, and that the Fortinet
OAuth profiles (password grant, no client secret) obtain tokens for FortiCare and FortiZTP.

### Vendor-login-only contracts

FortiCloud `products/register` and FortiZTP provisioning schemas (FNDN), Cisco API quotas (API
Console), and whether ShipEngine labels are tracked automatically or need `/v1/tracking/start`.
ShipEngine documents its retry: 10 s to answer 2xx, then at most two more attempts, typically 30
minutes apart, before the update is dropped; EasyPost retries up to 6 times, with a 7 s response
window. So a held Shipment lock is retried inside the app ([Return label, Ship and tracking
locks](#return-label-ship-and-tracking-locks)), and only the tracking webhook's 500 (refused save)
and its rare 503 (update that cannot be queued) rely on the aggregator's retry.
