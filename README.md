# NaaS Hardware Asset Management (`x_daas_ham`)

A ServiceNow scoped application, written with the ServiceNow SDK (Fluent), that gives a
**Network-as-a-Service provider** HAM-style hardware asset management for the switches, access points,
routers and firewalls it installs at customer sites and bills as a service.

It acts on **fleet assets** only. The platform's hardware, stockroom and model tables also hold the
Provider's own IT equipment (laptops, IT storerooms and their models), which the app leaves alone:
an Asset is in the fleet by its *Fleet* flag, a NaaS stockroom has a stockroom type and a NaaS Model
an OEM PID ([ADR 0016](docs/adr/0016-fleet-assets.md)).

- Plan of record: [`plan.md`](plan.md) (design decisions D1–D76 and phasing).
- Domain language: [`CONTEXT.md`](CONTEXT.md). Architecture decisions: [`docs/adr/`](docs/adr).
- Behaviour per module: [`docs/spec/`](docs/spec).

## What it does

| Area | Phase 1 (this release) |
|---|---|
| Ordering | "Request network equipment" record producer → Order + lines (site templates and single devices); entitlement check against the customer catalog and contracted quantities; approvals by customer admins / account manager |
| Sourcing | Hot spare at the Order's site (replacements) → customer spare pool → central stock (transfer to staging) → purchase order; daily spare-pool top-up |
| Fleet | Every Asset the app creates or receives joins the fleet; *Add to fleet* adopts equipment the Provider already runs; rules, jobs, lists, dashboards and the app's ACLs act on fleet assets, NaaS stockrooms and NaaS Models only |
| Inbound | ASN import (in-transit assets), warehouse scanning app (receive, provider tags + labels, put-away, pick) |
| Staging | Staging tasks with per-customer / vendor / device-class checklists; distributor-staged units get a verification checklist |
| Delivery | Ship → change request + FSM work order (inside change and site maintenance windows); self-install confirmation |
| In service | Seen signals from Discovery / connectors (CI last discovered) and the provider NMS (REST) put installed assets in service and start their subscription line |
| Models | Normalization of discovered models (PID, aliases, match rules, exceptions that teach rules); lifecycle (EoX) dates via CSV, kept in the platform's Model lifecycle table ([ADR 0017](docs/adr/0017-model-lifecycle-in-the-platform-table.md)); lifecycle phase and refresh due date per asset |
| Visibility | Customer admins see only their customer, site contacts their sites, inventory techs their stockrooms (of fleet assets and NaaS stockrooms; the Provider IT's equipment is left to the platform's access rules) |
| UI | NaaS Asset Workspace (`/x/daas/naas-assets/home`) with dashboard; navigator menu; warehouse page (`x_daas_ham_warehouse.do`) |

| Area | Phase 2 |
|---|---|
| OEM data | EoX and coverage from Cisco, Meraki, Fortinet and HPE Mist APIs; CSV for Aruba and Check Point; Cisco RMA status ([spec](docs/spec/p2-oem.md)) |
| Break-fix | Case → *Raise replacement* (hot spare, spare pool, stock, OEM advance replacement or purchase); replacement SLAs on the case |
| Returns | Decommission / removal requests, swap-backs, agreement-end and temporary-end returns; depot receipt and evaluation; overdue escalation, missing and fees |
| Refresh | Automatic refresh orders per agreement and site with successor-model choice |
| Disposal | Approved disposal orders retiring wiped assets by method and legal owner |
| Assurance | Blind counts, site audits, customer attestation, monitoring reconciliation exceptions |
| Racks | Placement guard, rack re-check exceptions (overlap, power budget) and rack elevation page (`x_daas_ham_racks.do`) |
| Customer self-service | `x_daas_ham_customer.do`: equipment, faults, returns, install confirmation, attestation |

| Area | Phase 3 |
|---|---|
| Leases | Lease schedules make their assets lessor-owned; mismatch alerts when a lease ends before the service; end-of-lease decisions (buy out, extend, return; one buy out or return per lease, returned stock withdrawn to pending wipe and swapped-back units evaluated into wiping, not stock) ([spec](docs/spec/p3-contracts.md)) |
| Renewals | Agreement renewal warnings and *Renew agreement*; OEM coverage expiry warnings per customer |
| Billing | Service intervals per asset; monthly billing periods prorated by day (site packages) and device-day (per-device lines, within the line's own dates) plus fees; review, regenerate, reset a stuck generation (admin), close and lock; CSV attachment and pull API ([spec](docs/spec/p3-billing.md)) |
| Margin | Cost facts (purchase write-off, lease, OEM support, field labour) and margin per customer and site on period close; dashboard tab |
| Shipping | Labels bought through a shipping aggregator at *Ship* and for ship-back returns; tracking webhooks ([spec](docs/spec/p3-integrations.md)) |
| OEM claims | Staging steps done by the OEM cloud: Meraki and Mist claim, GreenLake device add and subscription, FortiCloud registration and FortiZTP, Check Point Zero Touch |
| Racks | Power budget per rack from model typical power, with a *Rack over power budget* exception when simultaneous placements exceed it |

See [`docs/spec`](docs/spec) for the behaviour of each module. AI assistance is deferred (plan D68).

## Required plugins

Fluent cannot declare plugin dependencies, so check these before installing. After install, run the
on-demand job **NaaS - preflight check** (System Definition > Scheduled Jobs); its result is in
*NaaS Asset Management > Administration > Background jobs* (`preflight`).

| Capability | Plugin / product | Used for |
|---|---|---|
| Asset Management | base platform | `alm_hardware`, stockrooms, transfer orders |
| Model Management | `com.snc.model` (base platform) | Models and their lifecycle milestones (`cmdb_model_lifecycle`, `cmdb_hardware_model_lifecycle`) |
| Procurement | `com.snc.procurement` | purchase orders (`proc_po`, `proc_po_item`) |
| Customer Service Management | CSM (`com.sn_customerservice`) | `customer_account`, `customer_contact`, cases (P2), portal (P2) |
| Field Service Management | FSM (`com.snc.work_management`) | `wm_order` work orders |
| Change Management | ITSM | `change_request` (standard changes for routine work) |
| Discovery / Service Graph Connectors | ITOM | CI `last_discovered` as a Seen signal |

Roles the app's roles contain and that must exist: `asset`, `inventory_user`, `inventory_admin`,
`procurement_user`, `procurement_admin`, `model_manager`, `report_user`, `snc_external`, `canvas_user`,
`sn_customerservice_agent`.

Without these plugins the install fails and rolls back with only *Unable to install third party
application 'x_daas_ham'*: the app's tables reference theirs. On a personal developer instance,
activate them from *System Definition > Plugins* or with the CI/CD API
(`POST /api/sn_cicd/plugin/<id>/activate`).

### Vendor prefix

The scope `x_daas_ham` carries the vendor prefix `daas`. An instance whose vendor key differs (a
personal developer instance has a number, e.g. `2307953`) refuses the install with the same *Unable
to install third party application* error. Add `daas` to the system property
`sn_appauthor.all_company_keys`, comma-separated after the existing key (e.g. `2307953,daas`). Leave
`glide.appcreator.company.code` as it is: a comma list there becomes the scope prefix of new apps
(`x_2307953,daas_`) and does not let the install through.

## Install

```bash
npm install
npm run check                      # typecheck, lint, unit tests, build
npx now-sdk auth --add <alias>     # once per instance
npx now-sdk install --auth <alias> --no-demoData   # production: demo data loads unless turned off
npx now-sdk install --auth <alias>                  # dev/test: demo data included
```

The install log (*System Applications > Application install history*, `sys_upgrade_history_log`)
lists one *Skipped Error* row per global table the app adds columns to
(`sys_documentation_<table>__en`, seven of them): SDK 4.14 writes a table label for each augmented
table, and the platform keeps the table's own. Any other *Skipped Error* row is a defect. The app
no longer adds a column to `change_request` (ADR 0018), so the build now carries a delete for the
label it used to write there (`sys_documentation_change_request__en`, under the app's own sys_id,
which the platform never stored): after the install, check that the *Change Request* table still
has its label (*System Definition > Tables*).

Then configure (System Properties, `x_daas_ham.*`):

| Property | Set to |
|---|---|
| `x_daas_ham.provider_company` | sys_id of the provider's own `core_company` (company of unassigned stock) |
| `x_daas_ham.staging.default_stockroom` | sys_id of the staging-centre stockroom |
| `x_daas_ham.tag.prefix` / `.digits` | provider tag format (default `NAAS-0000001`) |
| `x_daas_ham.job.batch_size` / `.budget_seconds` | chunked-job tuning (defaults 500 / 120 s; a batch size below 1 counts as 1, and a budget of 0 or less handles one record per run); the OEM coverage sync shares the budget among the enabled vendors one batch at a time and gives each at least one batch per run |
| `x_daas_ham.events.max_batch` / `.retention_days` | NMS event API limits (500 / 90 days) |
| `x_daas_ham.spare_pool.auto_purchase` | `true` to raise POs for spare-pool shortfalls |
| `x_daas_ham.oem.<vendor>.enabled`, `x_daas_ham.meraki.*`, `x_daas_ham.mist.*` | OEM API access, see [OEM spec](docs/spec/p2-oem.md) |
| `x_daas_ham.oem.coverage_refresh_days` | days between coverage checks per asset (7) |
| `x_daas_ham.returns.grace_days` / `.temporary_lead_days` | missing after due + grace (14); temporary returns raised ahead (7) |
| `x_daas_ham.refresh.horizon_days` | refresh orders for assets due within (90) days |
| `x_daas_ham.reconciliation.unseen_days` | installed but unseen threshold (7) |
| `x_daas_ham.oem.coverage_warning_days` | warn about OEM coverage of deployed assets ending within (60) days |
| `x_daas_ham.leases.decision_group` | group that end-of-lease decisions are assigned to |
| `x_daas_ham.margin.amortisation_months` / `.visit_cost` | purchase write-off period (60) and standard field visit cost (250) |
| `x_daas_ham.shipping.*` | shipping aggregator: `enabled`, `api_key`, `carrier_id`, `webhook_token`, `service_code`, `package_kg`, `sender_name`, `sender_phone` |
| `x_daas_ham.oem.claim.<vendor>.enabled`, `.max_calls`, `x_daas_ham.checkpoint.api_client_id` / `.api_key` | OEM claims, see [integrations spec](docs/spec/p3-integrations.md) |
| `x_daas_ham.meraki.api_host`, `x_daas_ham.mist.api_host` | regional API hosts (defaults `api.meraki.com`, `api.mist.com`; set for Canada, China, India, FedRAMP or another Mist cloud) |

Assign roles (`x_daas_ham.asset_manager`, `.inventory_tech`, `.field_tech`, `.noc`, `.account_manager`,
`.finance`, `.admin`; customers: `.customer_admin`, `.site_contact`) and assign inventory techs to
their stockrooms ([ADR 0018](docs/adr/0018-platform-fields-over-custom-ones.md)): an inventory tech
works at the NaaS stockrooms whose *Assignment group* they are a member of. Setting a stockroom's
*Assignment group* takes the platform's `inventory_admin` (which `x_daas_ham.admin` contains); adding
a user to a group takes `user_admin`.

Mark what is NaaS ([ADR 0016](docs/adr/0016-fleet-assets.md)): give each NaaS stockroom its
*Stockroom type* (central depot, staging centre or customer site) and each NaaS Model its *OEM PID*.
A stockroom with no type and a Model without an OEM PID are the Provider IT's. Assets the app
creates (ASN rows, first scans without an ASN) and units it receives join the fleet. Equipment the
Provider already runs joins it with *Add to fleet* on the Asset form or list (asset managers): an
Asset on order, in transit, available in a NaaS stockroom, or in service with its Site and
Agreement, whose Model has an OEM PID.

### Demo data

Unless installed with `--no-demoData`, the on-demand job **NaaS - load demo data** is installed. Run
it once ("Execute Now"): it creates two customers (Acme Retail, Globex Logistics) with sites, racks
and stockrooms, models from Cisco/Meraki, HPE Aruba, Fortinet and Check Point, site templates,
agreements, subscription lines, catalog entries, staging checklists, demo users (`naas.inventory`,
`naas.field`, `acme.admin`, `acme.hq.contact`) and stock, in-service switches with OEM coverage,
service intervals and a lease that ends before the Acme agreement, and sets the two properties
above. Every demo Asset is a fleet asset (run again, the job adds to the fleet the demo Assets an
earlier version loaded), and the demo stockrooms and Models carry their stockroom type and OEM PID.
The demo depot and staging centre are assigned to the group *NaaS demo depot team*, which ships with
the demo data and gets `naas.inventory` as its member.
Lifecycle dates in the demo data are illustrative, not vendor bulletins.

## Integrations

**Provider NMS → device events** (`POST /api/x_daas_ham/naas/device_events`, role
`x_daas_ham.integration` or `x_daas_ham.asset_manager`):

```json
{ "events": [ { "identifier": "FOC1234X0AB", "event": "seen", "observed_at": "2026-11-06T10:00:00Z", "source": "nms" } ] }
```

`identifier` is a serial number, provider tag or customer tag; `event` is `seen`, `down` or `up`.
`observed_at` is an ISO-8601 timestamp with a UTC offset (`Z`, `±hh:mm` or `±hhmm`), to the minute,
second or fraction of a second; a time without an offset, another date format or a time that does not
exist (2026-02-31, 24:00) is a rejected row. Responds `202` with accepted / unknown identifiers /
busy identifiers / rejected rows. `accepted` counts only the events applied: unknown and busy
identifiers and rejected rows are not counted in it. `busy_identifiers` lists the events not applied
because another request was applying a sighting to the same Asset (job lock
`seen_asset_<Asset sys_id>`) or because the platform refused the Asset's save (logged as an error):
send those again. That is safe, because a repeated *seen* is not stored twice and last_seen only
moves forward. Only state changes are stored.

**Imports**: load CSVs into *ASN import rows* (`x_daas_ham_asn_import`, including MAC address and
OEM claim code), *Lifecycle import rows* (`x_daas_ham_eox_import`) and *OEM coverage import rows*
(`x_daas_ham_coverage_import`, optionally with the contract's annual cost) with System Import Sets >
Load Data; each row is processed on insert and its import state/comment shows the outcome. An ASN
row's check that no Asset has its serial sees every Asset, past the importer's stockroom rule. A
lifecycle row's milestones are stored in the platform's Model lifecycle table, one row per Model and
milestone ([ADR 0017](docs/adr/0017-model-lifecycle-in-the-platform-table.md)): a milestone the row
leaves blank keeps the date stored, and a row with no date at all is marked *ignored*. Asset managers
keep milestones by hand in *NaaS Asset Management > Model lifecycle* (the platform's `model_manager`
role, which the asset manager role contains): lifecycle type *Publisher*, the phase, its start date.
The list shows the *Publisher* rows of NaaS Models, the ones the app reads; a row left on the form's
default type, *Internal*, is an organisation's own plan for the Model, which the app ignores.

**Billing pull API** (role `x_daas_ham.finance` or `x_daas_ham.integration`):
`GET /api/x_daas_ham/naas/billing_periods` and
`GET /api/x_daas_ham/naas/billing_periods/{id}/lines?offset=0&limit=1000` (`final` once the period is
closed, `nextOffset` null on the last page).

**Shipping aggregator**: labels through the *NaaS Shipping aggregator* REST message (ShipEngine label
API, billed to `x_daas_ham.shipping.carrier_id`). Register the tracking webhook at
`https://<instance>/api/x_daas_ham/naas/shipping/tracking` with the custom header
`X-NaaS-Webhook-Token: <x_daas_ham.shipping.webhook_token>` (ShipEngine `headers`, EasyPost
`custom_headers`; `?token=` also works where the URL keeps it). ShipEngine and EasyPost tracker
payloads are accepted. Labels are not voided through the aggregator: while a return label is still
*Label created* or *Exception*, void it with the carrier, then use *Mark label voided* on its
Shipment so a new one can be created; a label in transit or out for delivery is the return under way.
Ship's labels are voided the same way: while one is *Label created* or *Exception*, void it with the
carrier and use *Mark label voided* on its Shipment. The Order's tracking number and carrier are
cleared, with a work note saying to buy the replacement with the carrier and type its tracking
number on the Order.

**OEM clouds**: REST messages *NaaS Meraki Dashboard*, *NaaS HPE Mist*, *NaaS HPE GreenLake*,
*NaaS FortiCare*, *NaaS FortiZTP* and *NaaS Check Point Zero Touch*. Attach OAuth 2.0 profiles to
GreenLake, FortiCare and FortiZTP; Meraki, Mist and Check Point take keys from password2 properties.
Each customer's org / subscription / FortiManager / Check Point "`<User Center account id>/<template id>`"
is an *OEM cloud account* record. Every contract the adapters rely on is checked against the vendors'
documentation in [docs/research/external-contracts.md](docs/research/external-contracts.md).

## Development

| Command | What it does |
|---|---|
| `npm run typecheck` | server modules, client app and tests |
| `npm run lint` | ESLint |
| `npm test` | Vitest unit tests for the domain core and client helpers |
| `npm run build` | `now-sdk build` (Fluent type check, client bundle, app package) |
| `npx now-sdk cicd testsuite run ...` | ATF suites **NaaS - P1**, **NaaS - P2** and **NaaS - P3** on an instance |

Layout:

```text
src/fluent/      Fluent metadata (*.now.ts): data/, security/, logic/, ui/, workspace/, tests/, demo/
src/server/
  domain/        pure TypeScript business rules, unit-tested (ADR 0003)
  platform/      Glide adapters: repositories and gateways
  entry/         business-rule / job / REST / UI-action entry points
src/client/      React UI pages (warehouse, rack elevation, customer self-service)
```

Conventions that the build or tests enforce:

- `.now.ts` files are literal: no helper functions, loops or string concatenation.
- Entry-point parameters must be named after the platform globals (`current`, `previous`, `event`,
  `producer`, `request`, `response`): the SDK wrapper passes them by name (`entry-points.test.ts`).
- A business rule condition fits the 254-character field and loads a module by its installed path,
  `x_daas_ham/<package name>/<version>/src/...`, calling a function it exports
  (`entry-points.test.ts`). A before rule on a table of another scope (`alm_hardware`, `wm_order`)
  refuses that way, with its Abort action, and its script only adds the reason: the platform ignores
  `current.setAbortAction` and `setWorkflow` called from this scope on such a table. So no entry
  point wired on one calls `setAbortAction`, and a rule with an Abort action has a condition
  (`entry-points.test.ts`). The platform runs a condition on every save of the table, whatever the
  rule's filter, so it starts with the change test that keeps the module unloaded on other saves
  ([external-contracts.md](docs/research/external-contracts.md#servicenow-platform)).
- Every stored choice value is defined once, in `domain/vocabulary.ts`: a Fluent column imports the
  list as its `choices:`, server code imports the type derived from it. Fluent evaluates that file
  statically, so it holds constants and types only (no imports, calls, spread or `satisfies` on a
  list).
- Substatus values added to `alm_asset` are the `choice` entries of `STAGE_FIELDS` there, which
  `fluent/data/substatus-choices.now.ts` ships one Record each (`substatus-choices.test.ts` compares
  the built choice set with them).
- Commit `src/fluent/generated/keys.ts`. Deleting Fluent code that was installed generates delete
  records; see the SDK's `fluent-overview` before removing metadata.

## Verify on the first install

The vendor and platform contracts were checked against primary documentation
([docs/research/external-contracts.md](docs/research/external-contracts.md)) and the code follows it.
What remains can only be confirmed on an instance or behind a vendor login:

- **Choices**: the instance accepts the app's `alm_asset.substatus` choice set (v2 format, only the
  app's 10 values). A Brazil instance already has *Pending evaluation* (`pending_evaluation`, In
  stock) and *Lease return* (`lease_return`, Retired), so the app ships neither and its stages use
  those values; on an older release check that both exist in
  `sys_choice name=alm_asset^element=substatus`.
- **Cross-scope access**: the privileges in `security/cross-scope.now.ts` match the scopes the instance
  reports (`alm_hardware`, `change_request`, `wm_order`, `proc_po`, `sys_attachment`, ...), including
  delete on `alm_transfer_order`, its lines and `proc_po`, which sourcing uses to remove a transfer order
  or purchase order created only in part (otherwise the line's sourcing summary names it for cancelling).
- **Model lifecycle** (ADR 0017; the platform's table and its rules were read on a Brazil instance, the
  app's use of it was not run there): a lifecycle import row for a NaaS Model stores one active row
  per milestone in `cmdb_model_lifecycle` (class *Hardware Model Lifecycle*, type *Publisher*, source
  *Internal*, the provenance as its description), stamps the Model's fleet assets with their
  Lifecycle phase, and queues `x_daas_ham.model.lifecycle` once; loaded again, it saves nothing. A
  milestone an asset manager changes in *Model lifecycle* stamps them again, and one of a Model
  without an OEM PID queues nothing. On an instance upgraded from a version that had
  `x_daas_ham_model_lifecycle`, check that the table is still there with its rows (the build deletes
  its ACLs, form, list and labels, not the table); the app no longer reads them: load them again
  through the lifecycle import or enter them by hand.
- **Stockroom assignment** (ADR 0018; the platform's columns, ACLs and table access were read on a
  Brazil instance, the app's use of them was not run there): an inventory-tech-only user who is a
  member of a NaaS stockroom's *Assignment group* sees that stockroom's fleet assets, staging tasks
  and blind counts and no other NaaS stockroom's; taken out of the group, none. With demo data, the
  group *NaaS demo depot team* is installed (a `sys_user_group` record in the app's demo data) and the
  demo job makes `naas.inventory` its member and sets it on *Central Depot Utrecht* and *Staging
  Centre Utrecht*; if the system log says the group was not found, create it by that name and run
  the job again. On an instance upgraded from a version that had `x_daas_ham_stockroom_member`, the
  app no longer reads its rows: give each NaaS stockroom an *Assignment group* holding its techs.
- **Platform fields** (ADR 0018), on an instance upgraded from a version that had the app's own
  columns: the old columns stay, unread. Fill in each lease's *Vendor* (its Lessor) and *Contract
  number* (until then a reference to the lease shows blank, and its return-to-lessor disposal order
  gets no vendor) and each racked Model's *Power (watts)* (until then it counts as 0 W in a rack's
  power budget). A work order opened by the earlier version has no *Initiated from*: set it to its
  NaaS Order while the work is open, or closing it will not confirm the install and its planned
  start is not checked against the change window (*Confirm installed* on the Order does the former).
- **On-site work links** (ADR 0018; not run on an instance): shipping an Order with an engineer
  install opens a change whose *Parent* is the Order and a work order whose *Initiated from* is the
  Order and whose *Parent* is the change; closing that work order complete confirms the install. A
  work order the Provider's IT initiated from another task (an incident, say) is left alone: closing
  it runs nothing of the app's, and its planned dates are not checked.
- **Fleet column** (ADR 0016): *Fleet* (`x_daas_ham_fleet`) on `alm_hardware` is a read-only
  boolean, default false, with the index `x_daas_ham_hw_fleet`, and the install sets it true on no
  row. The dictionary entries of *Legal owner* (`alm_hardware`) and *Stockroom type*
  (`alm_stockroom`) have no default value, and *Legal owner* offers *-- None --*: an Asset or
  Stockroom the Provider's IT creates on its form gets neither.
- **Add to fleet** (ADR 0016): impersonating an asset-manager-only user, *Add to fleet* (form button
  and list choice) is offered on an Asset outside the fleet and not on a fleet asset; an inventory
  tech is not offered it. On an Asset *In stock / Available* in a NaaS stockroom whose Model has an
  OEM PID it says *<tag> added to the fleet*: *Fleet* is set, a blank *Legal owner* becomes
  *Provider* (*Lessor* when its *Lease schedule* is set), and its stage stays as it was. On one
  whose Model has no OEM PID, one in a stockroom with no type, one reserved, or one in use without a
  Site and Agreement, it says *<tag> not added to the fleet: <reason>* and the Asset stays outside
  the fleet. Adopting an Asset in service opens no Service interval.
- **Equipment outside the fleet is left alone** (ADR 0016, ADR 0005): take one of the Provider IT's
  Assets, outside the fleet and *In use* (a laptop).
  - Rules: the lifecycle rule refuses no install status and substatus an asset manager without
    `admin` sets on its form, and the app neither checks nor follows up its *Lease schedule* or rack
    placement (its *Legal owner* stays as it is).
  - Jobs: the daily reconciliation raises no *unseen* exception for it, and resolves one raised
    before the Fleet flag; refresh orders, the OEM coverage sync, the spare-pool top-up,
    attestations and billing pass it by.
  - ACLs: a user with no NaaS role (the service desk) reads it as the platform's ACLs allow, and an
    inventory tech reads it as the platform allows whatever stockroom it is in.
  - Lists and dashboards: the NaaS workspace lists and dashboard and the navigator's Asset modules
    do not count it, a case's *Failed asset* does not offer it, the warehouse app's Look up answers
    HTTP 404 *No fleet asset with that serial or tag*, and a device event naming it is reported in
    `unknown_identifiers`.
- **Receiving outside the fleet** (warehouse app, ADR 0016): the stockroom list offers central
  depots and staging centres only, so a Provider IT storeroom (no stockroom type) is not offered,
  and `POST /api/x_daas_ham/naas/receive` (or `/putaway`) naming one answers HTTP 400 *Choose a NaaS
  stockroom: this one has no stockroom type*. Scanning the serial of the laptop above, with or
  without a PID, answers HTTP 409 *Not received: it is not a fleet asset: an asset manager adds it
  to the fleet first*, and no second Asset is created for the serial. A unit Procurement created on
  order for a purchase order, outside the fleet, is received and joins the fleet with the receipt
  when its Model has an OEM PID; when it has none the scan answers HTTP 409 *Not received: its Model
  has no OEM PID: give the Model its OEM PID first*.
- **Fleet after an upgrade** (an instance where an earlier version was installed, ADR 0016): the
  install flags no Asset, so the NaaS units from before are outside the fleet, and the app's rules,
  jobs, lists and dashboards pass them by until they are adopted. *Add to fleet* (list choice)
  adopts those on order, in transit, available in a NaaS stockroom or in service; running **NaaS -
  load demo data** again adopts the demo's. It refuses a unit in any other stage, and the app has no
  other way in: an administrator sets *Fleet* on such a unit by script. The earlier version's column
  defaults were also written on every row that existed when it was installed, and on each one
  created since without a value, and they stay after the upgrade. Clear them on the Provider IT's
  records:
  - `alm_stockroom`, filter `x_daas_ham_stockroom_type=central_depot`: this list also holds the
    NaaS central depots (the demo's *Central Depot Utrecht* is one), so do not use *Update All*.
    Select the Provider IT's storerooms only and clear *Stockroom type* with *Update Selected*.
    Until then a Provider IT storeroom counts as a central depot: it is offered for receiving and a
    blind count, and an inventory tech who is not its member does not see it. A NaaS depot cleared
    by mistake is no longer offered for receiving or a blind count, receiving there answers HTTP
    400 and sourcing does not draw on its stock, until its type is set back to *Central depot*.
  - `alm_hardware`, filter
    `x_daas_ham_fleet=false^ORx_daas_ham_fleetISEMPTY^x_daas_ham_legal_owner=provider`: clear
    *Legal owner* with *Update All*. A NaaS unit not yet adopted loses nothing: a blank Legal owner
    counts as the Provider's, and adoption sets it.
- **Procurement and FSM data**: the stored `proc_po` / `proc_po_item` status values and column names,
  `wm_order` state 3 = Closed Complete, and `last_discovered` / `discovery_source` as your connectors
  write them.
- **REST messages**: that `${meraki_host}` / `${mist_host}` substitute inside the endpoint host
  (otherwise use `setEndpoint`), that the GreenLake `find_device` filter URL is accepted, and that the
  Fortinet OAuth profiles (password grant, no client secret) obtain tokens for FortiCare and FortiZTP.
- **Vendor-login-only contracts**: FortiCloud `products/register` and FortiZTP provisioning schemas
  (FNDN), Cisco API quotas (API Console), and whether ShipEngine labels are tracked automatically or
  need `/v1/tracking/start`. ShipEngine documents its retry: 10 s to answer 2xx, then at most two
  more attempts, typically 30 minutes apart, before the update is dropped; EasyPost retries up to 6
  times, with a 7 s response window. So a held Shipment lock is retried inside the app (below), and
  only the tracking webhook's 500 (refused save) and its rare 503 (update that cannot be queued) rely
  on the aggregator's retry.
- **Job lock** (margin recomputes, ADR 0013): *Job lock* shows a unique database index on *Lock*; a
  second row with the same name is refused (`GlideRecord.insert()` returns no sys_id) without
  throwing, and the `x_daas_ham.margin.compute` event still ends as processed (a refused take tries
  the insert twice, before and after clearing abandoned locks, so two *Unique Key violation* errors in
  the system log per refused take are expected, three when the holder lets go between the second try
  and the check that follows and another take wins the third try; a third try that is accepted takes
  the lock); a lock row created over 10 minutes ago is cleared by the next recompute and a fresh one
  is not; a chunk that finds the lock held runs again about a minute later; a recompute whose lock was
  cleared while it was writing logs a *job lock lost while writing* warning and starts a fresh pass,
  which recomputes the period from scratch; a recompute whose clearing of the period's old Cost
  facts or Margin rows leaves a row (kept by a delete rule, say) stops with *Last margin error*
  *stopped: old Cost facts not all removed* (or *old Margin rows not all removed*) and logs
  *[x_daas_ham] Margin of <period> stopped: ...*; and no lock row is left once a recompute ends.
- **Provider tag counter** (warehouse Receive): the counter is advanced under the job lock
  `provider_tag_sequence`, so two units received at the same moment get different tags. A number
  whose tag an Asset already carries is skipped, so a counter set back (by a holder that outlasted
  the lock) skips the tags issued since; only a tag issued but not yet saved on its Asset when such a
  write lands could be issued again (ADR 0013). With *Cursor* of the `provider_tag_sequence` row in
  *Job cursor* set to 0, the next unit received gets the first tag no Asset carries. A receipt that
  finds the lock held 5 times in a row answers HTTP 503 *Other receipts are taking Provider tags: scan
  again* and leaves the unit unreceived; each refused try logs two *Unique Key violation* errors (up to
  10 for one 503). A try that meets the lock being released logs the same two, then tries a third
  insert, which normally takes it.
- **Receipt lock** (warehouse Receive and the overdue job): a receipt holds the job lock
  `receive_asset_<Asset sys_id>` and re-reads the Asset under it. When one unit is scanned on two
  devices at once, one receives it. The other answers HTTP 503 *Another scan is receiving this unit:
  scan again* and logs two *Unique Key violation* errors, or three when the holder lets go between the
  second try and the check that follows and another scan wins the third try. A scan that meets the
  holder letting go between its first and second try logs one and answers HTTP 409 *Not awaiting
  receipt*. The overdue job takes the same lock to declare a unit missing: one that finds it held logs
  the same two errors and leaves the unit to the scan and its line to the next day's run. No
  `receive_asset_` row is left once the receipt or the declaration ends.
- **Stock reservation lock** (Order sourcing, the spare-pool top-up, receiving's reservation for a
  waiting line, put-away and a lease return's withdrawal): reserving an Asset for an Order line,
  linking a hot spare at the customer site to one, or moving free stock into a Spare pool takes the
  job lock `reserve_asset_<Asset sys_id>` in the same *Job lock* table and re-reads the Asset under
  it, so two runs that pick the same Asset never both claim it. Put-away and the withdrawal of a
  returned lease's stock take the same lock, each trying 5 times, so neither moves a unit a claim is
  taking. The re-read also refuses a unit whose lease is being returned to its Lessor (end action
  *Return to lessor*), so such a unit is never reserved, linked or pooled. A run that finds the lock
  held leaves that Asset (the unit counts in its line's or pool's shortfall) and logs two *Unique Key
  violation* errors, or one when the holder lets go in between and the re-read finds the Asset taken,
  or three when the holder lets go between the second try and the check that follows and another run
  wins the third try. The holder may also be a put-away or a withdrawal, which leaves the unit free
  stock: the run still leaves it and counts it short, so a sourcing pass may buy for it. No
  `reserve_asset_` lock row is left once the run ends. A lock that cannot be taken for another reason
  logs *[x_daas_ham] Asset <id> not claimed: job lock ... could not be taken*, or *[x_daas_ham] Asset
  <id> not put away: job lock ... could not be taken* for a put-away, or *[x_daas_ham] Asset <id> not
  withdrawn for its lessor: ...* for a withdrawal. A withdrawal held off through its tries, or whose
  lock cannot be taken, logs *[x_daas_ham] Lease return: <serial> not withdrawn: its stock lock could
  not be taken*. A claim that outlasts its lock and gives the Asset up logs *[x_daas_ham] Asset <id>
  not claimed: its lock was lost while claiming it*. A receipt whose reservation finds the unit taken
  logs *[x_daas_ham] Received <serial> not reserved for <line>: another run claimed it, or the save
  was refused*; that also covers a reservation that met a put-away or withdrawal holding the lock. A
  receipt whose line, read again under its lock, no longer awaits stock or has all its units logs
  *[x_daas_ham] Received <serial> left in stock, not given to <line>: ...* and leaves the unit free
  stock.
- **Fee event and service interval locks**: charging a Fee event takes the job lock
  `fee_<type>_<Asset sys_id>_<Return order sys_id>`, and opening or closing a Service interval takes
  `service_interval_<Asset sys_id>`. In *Job lock*, create a row named
  `service_interval_<sys_id of a pending-in-service Asset>` by hand, then move that Asset into service:
  no Service interval opens, and the system log shows ten *Unique Key violation* errors and
  *[x_daas_ham] <serial> in service from <date>, no interval open: left to another save holding its
  lock ...* (error). Delete the row and the next go-live opens it. With the row in place, moving an
  Asset with an open interval out of service leaves it open and logs *[x_daas_ham] <serial> left
  service on <date>, its Service interval still open: ...* (error). A row named
  `fee_<type>_<Asset sys_id>_<Return order sys_id>` does the same to a line declared missing or a
  damaged evaluation saved: it logs *[x_daas_ham] <type> fee for <serial> not recorded: left to a run
  holding its lock ...* (warning) and records no fee. No `fee_` or `service_interval_` lock row is left
  after a normal charge, go-live or close.
- **Sighting lock** (device events and in-service detection): an NMS event or the 15-minute detection
  job applies a sighting under the job lock `seen_asset_<Asset sys_id>`. In *Job lock*, create a row
  named `seen_asset_<sys_id of a pending-in-service Asset>`, then POST a *seen* event for it. The POST
  answers `202` with its identifier in `busy_identifiers` and `accepted` 0, and each of the 10 refused
  tries logs two *Unique Key violation* errors. The 15-minute detection job leaves that Asset pending
  and logs nothing of its own for it: only the *Unique Key violation* errors of its refused tries
  appear. Delete the row and the next event or run puts it in service. No `seen_asset_` row is left
  afterwards. A go-live starts a pending Subscription line under `subscription_line_<line sys_id>`.
  With a row of that name created by hand in *Job lock*, a *seen* event for an Asset going live on
  that line is accepted. The Asset stays pending in service, ten *Unique Key violation* errors are
  logged, and so is *[x_daas_ham] <serial> stays pending in service, line not started: another
  go-live held its lock through every try* (warning). Delete the row and the next sighting starts the
  line. A row left more than 10 minutes is cleared as abandoned by the next take, which then starts
  the line. No `subscription_line_` row is left afterwards.
- **Refresh lock** (daily refresh Orders): the daily *NaaS - raise refresh orders* run holds the job
  lock `refresh_orders`. With a row of that name in *Job lock*, *Execute now* raises nothing. It logs
  two *Unique Key violation* errors and *[x_daas_ham] Refresh Orders not raised: another run holds the
  refresh_orders lock and raises them* (info). Delete the row and the next run raises them. A row left
  more than 10 minutes is cleared as abandoned by the next take, which then raises them. No
  `refresh_orders` row is left once a run ends.
- **Spare-pool lock** (daily spare-pool top-up): the *NaaS - spare pool top-up* run counts, fills
  and buys for each short Spare pool under the job lock `spare_pool_<Customer sys_id>_<Model
  sys_id>`. With a row of that name in *Job lock* for a pool that is short, *Execute now* moves
  nothing into it and buys nothing for it. Each of its 5 refused tries logs two *Unique Key
  violation* errors (up to 10), and the run logs *[x_daas_ham] Spare pool of <Customer sys_id> for
  <Model sys_id> not topped up: another run holds the spare_pool_... lock and tops it up* (info).
  Delete the row and the next run tops it up. A row left more than 10 minutes is cleared as
  abandoned by the next take. No `spare_pool_` row is left once a run ends.
- **Sourcing locks** (Order sourcing and receiving): a sourcing pass holds the job lock
  `source_order_<Order sys_id>` for its whole run, and reads and saves each line under
  `order_line_<line sys_id>`, which a receipt for a waiting line takes too. A pass that finds the
  Order's lock held logs two *Unique Key violation* errors and *[x_daas_ham] <Order> sourced again in
  60 s: another pass or a cancel holds its lock* (info), and runs again a minute later. A request
  queued again 15 times logs *[x_daas_ham] <Order> not sourced again after 15 tries (...): check its
  lines* (warning) and is dropped. A line lock is tried 10 times, each refused try logging two errors
  (up to 20). Held through them all, sourcing leaves the line to the pass queued again (after picking
  stock, it logs *[x_daas_ham] <line> left to the next sourcing pass (...)*, naming any transfer
  orders the line does not list), and a receipt answers HTTP 503 *Its order line is being sourced or
  received: scan again* and saves nothing. A received unit whose reservation fails queues
  `x_daas_ham.order.source` for its Order: one *not reserved for <line>* warning is followed by a
  sourcing pass, not by a stalled line. *Cancel order* takes `source_order_<Order sys_id>` too: with
  a row of that name in *Job lock*, it says *Order not cancelled: sourcing is running on it. Try
  again in a minute* and changes nothing. Under it, it also takes `ship_order_<Order sys_id>`: with
  a row of that name in place (and none for `source_order_`), it says *Order not cancelled: a Ship
  of the Order is running. Try again once it is done* and changes nothing. No `source_order_`,
  `ship_order_` or `order_line_` row is left once a run or a cancel ends.
- **Units that leave in transit** (Order lines): a shipped unit of an Order moved to missing or
  pending return (a device removal) logs *[x_daas_ham] <serial> left <line> in transit (<stage>):
  taken off the line, which is filled again* (info), followed by a queued `x_daas_ham.order.source`
  pass. The after rule's nested Asset save that clears `x_daas_ham_order_line` runs no stage rules
  and keeps the outer save's stage. A nested save the platform refuses logs *[x_daas_ham] <serial>
  left <line> in transit (<stage>) but stays on it, which is not sourced again: <reason>* (warning),
  and a line that cannot be saved back to awaiting stock logs *[x_daas_ham] <line> lost a unit in
  transit but is not sourced again* (warning).
- **Re-check approvals** (Order form, next to *Submit*, *Ship*, *Confirm installed* and *Cancel
  order*): its condition, an inline `sysapproval_approver` query kept under the 254-character
  condition limit, shows the button only on an Order awaiting approval with no requested approval.
- **Confirm installed** (Order form): its condition, an inline `alm_hardware` query (substatus
  `shipped_to_site`) kept under the 254-character limit, shows the button on an Order installing,
  or on one with shipped units (back in preparing or delivering after a unit was lost in transit),
  to holders of the platform `asset` role (asset managers, field techs), and to Customer contacts
  only on self-install Orders. Check that a site contact sees it on a self-install Order back in
  preparing with one shipped unit, and that confirming moves only that unit.
- **Serial lock** (warehouse Receive without an ASN, and ASN import rows): the first scan of an
  unknown serial with its PID, or an ASN row, creates the Asset under the job lock
  `receive_serial_<serial>`, checking there that no Asset has the serial, so two first scans, or a
  scan and an ASN row, create one Asset. The other scan answers HTTP 503 *Another scan is receiving
  this unit: scan again* and logs two *Unique Key violation* errors; its rescan finds the Asset by
  serial. An ASN row tries the lock 5 times: with a row `receive_serial_<serial>` created by hand in
  *Job lock*, an ASN row loaded for that serial is marked error *serial <serial> not imported: a scan
  or another row is receiving it; load this row again*, and ten *Unique Key violation* errors are
  logged. No `receive_serial_` row is left once the receipt or the import ends.
- **Return label, Ship and tracking locks**: *Create return label* holds the job lock
  `return_label_<Return order sys_id>` while it checks for an open label and buys one. A second press
  while one is being bought says *A return label is already being bought for this return* and buys
  nothing. *Ship* holds `ship_order_<Order sys_id>`: a second Ship says *Another Ship of this Order is
  running* and ships, buys and opens nothing. *Cancel order* holds the same lock while it checks and
  releases the Order's lines; a Ship pressed then says the same. Each refused take logs two *Unique
  Key violation* errors. The tracking webhook holds `track_shipment_<Shipment sys_id>` while it
  saves the status and inserts new events, and *Mark label voided* while it checks and saves the
  void. A busy lock is retried inside the app, not by the aggregator. With a row of that name
  created by hand in *Job lock*, a delivery answers HTTP 202 `{"matched": true, "queued": true}`
  within a second, logs two *Unique Key violation* errors per try (up to 10) and *[x_daas_ham]
  Tracking update of Shipment <number> (<tracking number>) queued in 1 event(s): another update held
  its lock* (info), and saves nothing yet. The `x_daas_ham.shipment.track` event then tries again as
  soon as it is processed and about every minute after, each try logging up to 10 more errors and
  *... tried again in 60 s: another update held its lock*. Delete the row and the next try saves the
  status and events (and notes a delivery on the Order once); left in place, the first try once the
  row is 10 minutes old clears it as abandoned and saves them.
  A retry still held off after 15 re-queues logs *[x_daas_ham] Tracking update of Shipment <number>
  (<tracking number>) dropped after 15 tries (...): check the Shipment with the carrier* (warning).
  With the row in place, *Mark label voided* says *Label <tracking number> not marked voided: a
  tracking update of it is being saved. Try again* and changes nothing. *Mark label voided* on an
  outbound label also holds `ship_order_<Order sys_id>`. With a row of that name in place, it says
  *Label <tracking number> not marked voided: a Ship of its Order, or a void of one of its labels, is
  running. Try again once it has finished* and changes nothing, and a Ship pressed while a void holds
  the lock says *Another Ship of this Order is running*. No lock row is left afterwards.
  The queued update travels in the event's `parm1`, at most 4000 characters (a long history is shared
  out over several events, never cut): check that `sysevent.parm1` holds that many on the instance
  (its dictionary max length), as the 4000 comes from community answers, not ServiceNow's
  documentation. A longer value would be cut on save and the retry dropped as *parm1 is not an
  update*.
- **Inventory tech access** (ADR 0005), also after upgrading an existing install: the ACLs that
  `security/acls*.now.ts` give `broadStaff` (agreements, subscription lines, catalog entries, site
  templates, fee events, attestations, leases, OEM coverage and cloud accounts, model data, device
  events, reconciliation exceptions, ...) no longer list `x_daas_ham.inventory_tech`
  in `sys_security_acl_role`. Impersonating an inventory-tech-only user, the Agreements list is denied,
  other stockrooms' blind counts and site audits are not listed, and in the warehouse app receiving one
  returned unit of a multi-unit site package keeps its subscription line active, receiving the last one
  ends it, and a late one records the late-return fee. Impersonating a field-tech-only user, the
  warehouse app offers only Audit and Look up, and `POST /api/x_daas_ham/naas/receive` (and
  `/putaway`, `/pick`, `GET /stockrooms`) answers HTTP 403.
- **Reads past the visibility rules** (ADR 0005, `platform/beyond-visibility.ts`): impersonating an
  inventory-tech-only user assigned to one stockroom, the Assets list shows that stockroom's fleet
  assets and no other stockroom's (beside the Provider IT's hardware, as the platform's ACLs allow),
  yet in the warehouse app scanning the serial of a unit in transit (in no stockroom yet) receives
  that Asset, not *Unknown serial: scan the PID too ...*, an ASN row for a serial an Asset of
  another stockroom carries is marked error *serial <serial> already exists*, Ship of an Order whose
  hot spare sits in the customer-site stockroom ships the spare with the staged units, and placing
  an Asset in rack units a device at the Site already fills (in none of the tech's stockrooms) is
  refused with the overlap reason.
- **Hardware ACLs on `alm_asset`** (ADR 0005): `sys_security_acl` holds no read ACL of the app on
  `alm_hardware`. The records keyed `acl_alm_hardware_read_staff` and
  `acl_alm_hardware_read_customer` (`keys.ts`) name `alm_asset`, with *Applies To*
  `sys_class_name=alm_hardware`, and after an upgrade they were moved there, not copied. Beside
  them, the row check keyed `acl_alm_asset_read_scope` is a Deny-Unless read ACL with no role, whose
  script is a function of the app's module. A user with no NaaS role (the service desk, an IT asset
  manager) reads hardware, fleet assets included, as the platform's ACLs allow.
- **Row checks** (ADR 0005, `security/acls-visibility.now.ts`): impersonating an inventory-tech-only
  user assigned to one stockroom, the list `alm_hardware_list.do?sysparm_query=sys_id=<fleet asset
  of another stockroom>^NQsys_id=<fleet asset of theirs>` shows only their unit, with a *rows
  removed by security constraints* gap: the Deny-Unless check on `alm_asset` applies to an
  `alm_hardware` record that a query the rule does not narrow reaches. The same query on
  `alm_asset_list.do` shows the same. Their `alm_asset` list shows consumables and licences as
  before the install (*Applies To* keeps the app's ACLs off the other classes of Asset) and leaves
  out other stockrooms' fleet assets, with such gaps (ADR 0005). A New form of an Audit or a Staging
  task opens.
- **Returns and site packages**: when an Agreement with equipment at two Sites ends, the daily job
  raises one Return order per Site, each with a normal change and a de-install work order located at
  that Site. A site package whose last outstanding unit is declared missing ends that day. With every
  unit of a one-site package swapped (a break-fix swap of a one-device package, for example),
  receiving the old units before the new ones are seen leaves the package active, and returning or
  declaring missing the never-seen new units then ends it. After an upgrade, site packages kept active
  by a unit declared missing before this release are not ended retroactively: list active
  site-package lines whose Site has no Asset under the Agreement shipped, pending in service, in
  service, temporary or pending return, and end them by hand. Agreements that ended before this
  release had their agreement-end Returns raised without the units still shipped to a Site: list
  Assets whose Agreement has *End-of-agreement return raised* set and which are shipped, pending in
  service, in service or temporary, and return them by hand (record producer, device removal).
  Lessor-owned units of a returned lease that were evaluated as refurbish before this release may
  still sit in available stock: sourcing no longer claims them, but they are not withdrawn. List
  available Assets whose lease's end action is *Return to lessor*, move them to pending wipe and put
  them on a *return to lessor* disposal order. The spare-pool top-up no longer counts spare-pool units
  of a returned lease as reserved spares, so its first run after the upgrade may move free stock into
  those Customers' pools (and buy for them when `x_daas_ham.spare_pool.auto_purchase` is true).
  Withdraw a returned lease's spare-pool units the same way. Each fee type is now charged at most once
  per Asset and Return order. Before this release, a damage fee could be charged twice when an
  evaluation was chosen again after the lifecycle refused the move: list Fee events (not waived) that
  share type, Asset and Return order, and waive the duplicates.
- **Meraki coverage** (after an upgrade): Meraki Assets' coverage is now asked of Cisco SN2INFO only
  when both `x_daas_ham.oem.meraki.enabled` and `x_daas_ham.oem.cisco.enabled` are true. An install
  that had only Cisco enabled stops refreshing Meraki coverage until the Meraki property is turned on.
- **Order create rule in jobs**: an Order is submitted only when its user passes the Order create rule
  (`GlideRecord.canCreate()`). The daily job *NaaS - raise refresh orders* relies on its *Run as* user
  (expected to be the system user) passing it; one without an Order raiser role leaves its refresh
  Orders as drafts with the work note *You may not raise orders*.
- **Refusals on `alm_hardware` and `wm_order`** (the rules' Abort action): a user without `admin`
  who sets a fleet asset's install status and substatus on the form to a move the lifecycle does not
  allow (*Available* to *In use*, say) or to a combination the app does not model gets the reason as
  an error, and the Asset keeps its stage; an administrator's same save is written. A save into
  staging clears *Wiped on* and *Wipe certificate*, an administrator's too. Moving the planned start
  of a NaaS Order's work order outside its change window on the form is refused with *The work must
  be scheduled inside the change window*. A save by script that these rules refuse returns no
  sys_id, and its last error names the rule (*Operation against file 'alm_hardware' was aborted by
  Business Rule ...*), not the reason (external-contracts N36).
- **Transfer orders** (ADR 0002, external-contracts N38, N39): impersonating an inventory-tech-only
  user, work through its tasks a transfer order sourcing raised (an Order line filled from stock
  outside the staging centre). Each unit's history shows it handed over *In stock / Available* just
  before its line was inserted, and Inventory then putting it *In stock / Pending transfer* with
  *Active transfer order* set: the Asset is *In transfer*, its Staging task is open and its Order
  line counts it as sourced. A blind count started in the stockroom it leaves expects it. Closing
  the tasks to *Requested*, *Shipment Preparation* and *In Transit* (*In transit / Reserved*) is not
  refused. Receiving the line at the staging centre leaves the unit *In stock / Staging* there, not
  *Available*, with the flag and its wipe evidence cleared, and its Staging task can be finished.
  Cancelling another such line before it is received puts its unit back as free stock (*Available*,
  under the Provider company) in the stockroom it was sent from, skips its Staging task, sources its
  Order again and logs *[x_daas_ham] <serial> left its transfer to the staging centre in
  <stockroom>: put back as free stock, its line sourced again* (warning).
- **Transfer refusals** (ADR 0002; ATF cannot check them, as the lifecycle rule checks interactive
  saves only): as a user without `admin`, setting *In stock / Pending transfer* on the form of an
  available fleet asset on no open line is refused with *An asset is in transfer only while it is on
  an open transfer order line*, and setting *In stock / Available* on one whose line is open with
  *An asset leaves transfer only once Inventory lets it go from its transfer order line*. *Cancel
  order* takes a unit in transfer off its Order line and leaves it in transfer; once Inventory lets
  it go, it is *Available*. A line received after its last task was closed skipped leaves its Asset
  in transfer with the flag cleared, and its stage can then be set on the form.
- **Rack re-check** (D67): two saves placing Assets into the same rack units at the same moment both
  pass the before rule, and the after rule of the later one, reading the rack afresh, sees both and
  opens *Devices overlap in rack* (or *Rack over power budget*) on the rack. Moving one device away
  resolves it. A Model or rack capacity edit that clears it is resolved by the next daily
  reconciliation.
- **Scale**: before-query rule performance and the chunked jobs at your data volumes (indexes are
  declared on the scoped columns).
- **Currency**: amounts are written in each line's currency (default EUR); confirm the session
  currency of the job user if you bill in several currencies.
