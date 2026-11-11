# NaaS Hardware Asset Management (`x_daas_ham`)

A ServiceNow scoped application, written with the ServiceNow SDK (Fluent), that gives a
**Network-as-a-Service provider** HAM-style hardware asset management for the switches, access points,
routers and firewalls it installs at customer sites and bills as a service.

It acts on **fleet assets** only. The platform's hardware, stockroom and model tables also hold the
Provider's own IT equipment (laptops, IT storerooms and their models), which the app leaves alone:
an Asset is in the fleet by its *Fleet* flag, a NaaS stockroom has a stockroom type and a NaaS Model
an OEM PID ([ADR 0016](docs/adr/0016-fleet-assets.md)).

- Plan of record: [`plan.md`](plan.md) (decision log Q1–Q76 and phasing).
- Domain language: [`CONTEXT.md`](CONTEXT.md). Architecture decisions: [`docs/adr/`](docs/adr).
- Behaviour per module: [`docs/spec/`](docs/spec).

## What it does

| Area | Phase 1 (this release) |
|---|---|
| Ordering | "Request network equipment" record producer → Order + lines (site templates and single devices); entitlement check against the customer's catalog entries and contracted quantities; approvals by customer admins / account manager |
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
| Margin | Cost facts (purchase write-off, lease, OEM support, field labour, shipping) and margin per customer, site and currency on period close (two currencies are never added); dashboard tab |
| Shipping | Labels bought through a shipping aggregator at *Ship* and for ship-back returns; tracking webhooks ([spec](docs/spec/p3-integrations.md)) |
| OEM claims | Staging steps done by the OEM cloud: Meraki and Mist claim, GreenLake device add and subscription, FortiCloud registration and FortiZTP, Check Point Zero Touch |
| Racks | Power budget per rack from model typical power, with a *Rack over power budget* exception when simultaneous placements exceed it |

See [`docs/spec`](docs/spec) for the behaviour of each module. AI assistance is deferred (plan Q68).

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
`procurement_user`, `procurement_admin`, `model_manager`, `report_user`, `snc_external`, `canvas_user`.
The app also grants Customer Service's `sn_customerservice_agent` (the service desk) directly, in
its ACLs, the *Submit* and *Raise replacement* buttons and the request and return menu modules, so
it must exist too. The preflight check looks for all ten.

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
npm run check                      # typecheck, lint, build, unit tests
npx now-sdk auth --add <alias>     # once per instance
npx now-sdk install --auth <alias> --no-demoData   # production: demo data loads unless turned off
npx now-sdk install --auth <alias>                  # dev/test: demo data included
```

The install log lists seven expected *Skipped Error* rows; any other is a defect
([install log](docs/verify-on-instance.md#install-log)).

Then configure (System Properties, `x_daas_ham.*`):

| Property | Set to |
|---|---|
| `x_daas_ham.provider_company` | sys_id of the provider's own `core_company` (company of unassigned stock) |
| `x_daas_ham.staging.default_stockroom` | sys_id of the staging-centre stockroom |
| `x_daas_ham.tag.prefix` / `.digits` | provider tag format (default `NAAS-0000001`) |
| `x_daas_ham.job.batch_size` / `.budget_seconds` | chunked-job tuning (defaults 500 / 120 s; a batch size below 1 counts as 1, and a budget of 0 or less handles one record per run); the OEM coverage sync shares the budget among the enabled vendors one batch at a time and gives each at least one batch per run, and the refresh run reads no further page of due Assets once it is spent |
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
*Stockroom type* (central depot, staging centre or customer site) and each NaaS Model its *OEM PID*
and a *Model category* (e.g. *Network Gear*). A stockroom with no type and a Model without an OEM
PID are the Provider IT's. Procurement refuses a purchase order line item whose Model has no
category (its rule *Model Category of Model not empty*), so the app requests no purchase order for
such a Model and says why; a purchase order left without its line item is cancelled, as
Procurement lets no other scope delete one
([purchase orders](docs/verify-on-instance.md#purchase-orders)). Assets the app creates (ASN rows,
first scans without an ASN) and units it receives join the fleet. Equipment the Provider already
runs joins it with *Add to fleet* on the Asset form or list (asset managers): an Asset on order, in
transit, available in a NaaS stockroom, or in service with its Site and Agreement, whose Model has
an OEM PID.

Give each Agreement its *Currency*, a three-letter ISO code with no default: the Agreement bills in
that one currency, and its lines and fees fail to bill until it is set
([Agreement currency](docs/spec/p3-contracts.md#agreement-currency)).

### Upgrading

On an instance where an earlier version was installed:

- Set *Currency* on every Agreement saved before the field existed, before the next Billing period
  is generated ([currency](docs/verify-on-instance.md#currency)); the demo job sets EUR on the demo
  Agreements when it runs again.
- Give every NaaS Model its *Model category*
  ([purchase orders](docs/verify-on-instance.md#purchase-orders)).
- Enter again what the app now keeps in the platform's own tables and fields
  ([ADR 0017](docs/adr/0017-model-lifecycle-in-the-platform-table.md),
  [ADR 0018](docs/adr/0018-platform-fields-over-custom-ones.md)). The earlier version's tables and
  columns stay on the instance with their values, unread: the build deletes none of them, and
  nothing is migrated.
  - Give each NaaS stockroom an *Assignment group* holding the inventory techs who were its
    stockroom members ([stockroom assignment](docs/verify-on-instance.md#stockroom-assignment)).
  - Fill in each lease's *Vendor* (its Lessor) and *Contract number* and each racked Model's *Power
    (watts)*, and set *Initiated from* to its NaaS Order, Return order or Audit on each work order
    still open or closed in a month whose Margin is still to be computed
    ([platform fields](docs/verify-on-instance.md#platform-fields)).
  - Load the Models' lifecycle milestones again through the lifecycle import, or enter them by hand
    ([model lifecycle](docs/verify-on-instance.md#model-lifecycle)).
- Work through the checks marked **After an upgrade** in
  [docs/verify-on-instance.md](docs/verify-on-instance.md): adopting the fleet and clearing the
  earlier version's column defaults, and clean-ups of returns, fees and spare-pool purchases.

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

It loads nothing on an instance whose Provider (`x_daas_ham.provider_company`) names a company
other than *Demo NaaS Provider*, as an instance in use does, and logs why as an error: on a
dev/test instance, clear the property first. The demo Agreements bill in EUR; run again, the job
gives that currency to any demo Agreement an earlier version loaded without one.

## Integrations

**Provider NMS → device events** (`POST /api/x_daas_ham/naas/device_events`, role
`x_daas_ham.integration` or `x_daas_ham.asset_manager`):

```json
{ "events": [ { "identifier": "FOC1234X0AB", "event": "seen", "observed_at": "2026-11-06T10:00:00Z", "source": "nms" } ] }
```

`identifier` is a serial number, provider tag or customer tag, matched in that order (the first
field any fleet asset carries it in); one that two fleet assets carry in that field, such as a
customer tag two Customers share, is refused, logged, and reported in `unknown_identifiers`. `event`
is `seen`, `down` or `up`. `observed_at` is an ISO-8601 timestamp with a UTC offset (`Z`, `±hh:mm`
or `±hhmm`), to the minute, second or fraction of a second; a time without an offset, another date
format or a time that does not exist (2026-02-31, 24:00) is a rejected row. Events are applied in
the order they were observed, oldest first, whatever their order in the request. Responds `202` with
accepted / unknown identifiers / busy identifiers / rejected rows. `accepted` counts only the events
applied: unknown and busy identifiers and rejected rows are not counted in it. `busy_identifiers`
lists the events not applied because another request was applying a sighting to the same Asset (job
lock `seen_asset_<Asset sys_id>`) or because the platform refused the Asset's save (logged as an
error): send those again. That is safe, because a repeated *seen* is not stored twice and last_seen
only moves forward. Only state changes are stored.

**Imports**: load CSVs into *ASN import rows* (`x_daas_ham_asn_import`, including MAC address and
OEM claim code), *Lifecycle import rows* (`x_daas_ham_eox_import`) and *OEM coverage import rows*
(`x_daas_ham_coverage_import`, optionally with the contract's annual cost) with System Import Sets >
Load Data; loading takes the platform's `import_set_loader` role (`import_admin` contains it), which
no NaaS role contains, and the NaaS menu's *Load data* module is shown to holders of that role; each
row is processed on insert and its import state/comment shows the outcome. An ASN row's check that
no Asset has its serial sees every Asset, past the importer's stockroom rule. A lifecycle row's
milestones are stored in the platform's Model lifecycle table, one row per Model and milestone
([ADR 0017](docs/adr/0017-model-lifecycle-in-the-platform-table.md)): a milestone the row leaves
blank keeps the date stored, and a row with no date at all is marked *ignored*. Asset managers keep
milestones by hand in *NaaS Asset Management > Model lifecycle* (the platform's `model_manager`
role, which the asset manager role contains): lifecycle type *Publisher*, the phase, its start date.
The list shows the *Publisher* rows of NaaS Models, the ones the app reads; a row left on the form's
default type, *Internal*, is an organisation's own plan for the Model, which the app ignores.

**Billing pull API** (role `x_daas_ham.finance` or `x_daas_ham.integration`):
`GET /api/x_daas_ham/naas/billing_periods` and
`GET /api/x_daas_ham/naas/billing_periods/{id}/lines?offset=0&limit=1000` (`final` once the period is
closed, `nextOffset` null on the last page). Each line carries its `currency`, and a period its
`totals`, one per currency: there is no single `total`, as two currencies are never added
([billing spec](docs/spec/p3-billing.md)).

The NMS and billing integrations sign in as an internal user, one without the `snc_external` role
(the Explicit Roles plugin gives such a user `snc_internal`). Their routes, like the warehouse ones,
require `snc_internal` and the platform's *Scripted REST External Default* ACL. Only the site, rack
and `/customer/...` routes admit customer admins and site contacts (`shared/rest-acls.now.ts`).
The tracking webhook needs no sign-in and checks its token itself.

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
| `npm test` | Vitest: the domain core, the platform services and visibility scripts against an in-memory stand-in for Glide, the client helpers, and the checks of the built metadata. Those checks all fail once any file under `src/fluent` or `src/server` (tests aside) is newer than `dist/app`: run `npm run build` first, or `npx vitest run src/server/domain` while working on rules |
| `npm run build` | `now-sdk build` (Fluent type check, client bundle, app package) |
| `npx now-sdk cicd testsuite run ...` | ATF suites **NaaS - P1**, **NaaS - P2** and **NaaS - P3** on an instance (`src/server/atf-scripts.test.ts` checks their server-side scripts beforehand; [running ATF](docs/verify-on-instance.md#running-atf)) |

Layout:

```text
src/fluent/      Fluent metadata (*.now.ts): a folder per feature, shared/, workspace/ (see below)
src/server/
  domain/        pure TypeScript business rules, unit-tested (ADR 0003)
  platform/      Glide access: the operations (raise, source, ship, receive, bill) as services,
                 with their repositories and gateways
  entry/         one thin adapter per trigger (business rule, job, REST, UI action): reads its
                 inputs, calls a platform service, reports the outcome
  test-support/  the tests' in-memory stand-in for Glide and their encoded-query evaluator
src/client/      React UI pages (warehouse, rack elevation, customer self-service)
```

Conventions that the build or tests enforce:

- `domain/` imports neither Glide nor `platform/` or `entry/`; `platform/` never imports `entry/`;
  no entry module imports another; a relative import in `src/server` names the `.ts` file, because
  the instance resolves a module by its exact path (`.now.ts` imports are written without it).
  ESLint enforces all four (`eslint.config.js`), and no domain module imports another in a cycle
  (`domain/import-cycles.test.ts`).
- A test is a `*.test.ts` file beside the module it tests. `src/server/tsconfig.json` and
  `now.config.json` leave those files and `src/server/test-support/` out, so none reaches the
  instance.
- A test of a platform service or an entry adapter runs against `test-support/fake-glide.ts`, the
  one stand-in for `@servicenow/glide`: tables in memory, queried through the tests' encoded-query
  evaluator (`test-support/encoded-query.ts`), with the refusals, clock, user, queued events and log
  a test sets up. It keeps the platform's behaviour where that is known and throws on what it does
  not know (an operator, a dot-walk through a reference the test did not declare, a Glide method it
  lacks), so no test passes on a guess. It runs no business rule, ACL or flow: those are ATF's.
- `.now.ts` files are evaluated by the SDK, not run: they hold constants, template literals over
  constants and property access, and imports of constants (from `src/server/domain` and
  `src/server/platform` too), but no function call, loop, spread or array element. A value the SDK
  cannot read is no build error: the record is built with `Symbol(...)` or `[object Object]` in it,
  which `built-metadata.test.ts` finds in the built output (so it needs `npx now-sdk build` first;
  `npm run check` builds before it tests).
- What a query, qualifier or condition tells NaaS records by (the Fleet flag, a NaaS stockroom type,
  an OEM PID, a customer Site) is a constant of `domain/fleet.ts`, which the Fluent metadata imports.
- Entry-point parameters must be named after the platform globals (`current`, `previous`, `event`,
  `producer`, `request`, `response`): the SDK wrapper passes them by name (`built-metadata.test.ts`).
- A business rule condition fits the 254-character field and loads a module by its installed path,
  `x_daas_ham/<package name>/<version>/src/...` (`fluent/shared/server-modules.now.ts` builds it from
  `package.json` and `now.config.json`), calling a function it exports (`built-metadata.test.ts`). A
  before rule on a table of another scope (`alm_hardware`, `wm_order`) refuses that way, with its
  Abort action, and its script only adds the reason: the platform ignores `current.setAbortAction`
  and `setWorkflow` called from this scope on such a table. So an entry point wired on one takes its
  record as a `ForeignRecord` (`platform/records.ts`), a type without those two methods: neither it
  nor a helper it hands the record to compiles with such a call. `built-metadata.test.ts` holds the
  entry points the rules on those tables call to that type, and a rule with an Abort action to
  having a condition. The platform runs a condition on every save of the table, whatever the rule's
  filter, so it starts with the change test that keeps the module unloaded on other saves
  ([external-contracts.md](docs/research/external-contracts.md#servicenow-platform)).
- Every stored choice value is defined once, in `domain/vocabulary.ts`: a Fluent column imports the
  list as its `choices:`, server code imports the type derived from it. Fluent evaluates that file
  statically, so it holds constants and types only (no imports, calls, spread or `satisfies` on a
  list).
- A set of those values (the ended Order stages, the stages in use, the open RMAs) is defined once,
  in the domain module that owns the concept, from the list's values by name (`ORDER_STAGE.rejected`).
  A query or condition the metadata needs is a constant written out beside the set, which a unit test
  holds to it; a UI action condition that restates a server rule is run as built against every value
  (`built-metadata.test.ts`).
- The names the metadata and the server code must agree on each have one list, which both import:
  role names and the platform roles the app needs (`domain/visibility.ts` `ROLE`, `PLATFORM_ROLE`;
  the role groups are in `fluent/shared/roles.now.ts`), events (`platform/events.ts` `EVENT`),
  system properties with their shipped values (`platform/properties.ts` `PROPERTY`: a reader takes
  the entry and falls back to that value) and REST messages with their functions
  (`domain/rest-message-names.ts` `REST_MESSAGE`). `built-metadata.test.ts` holds what was built to
  each list.
- The name of a business rule, UI action, script action, notification, SLA, REST message or REST
  route fits the instance's 40 characters, which cut a longer one off unseen
  (`built-metadata.test.ts`).
- Substatus values added to `alm_asset` are the `choice` entries of `STAGE_FIELDS` in
  `domain/vocabulary.ts`, which `fluent/fleet/tables.now.ts` ships one Record each
  (`built-metadata.test.ts` compares the built choice set with them).
- Commit `src/fluent/generated/keys.ts`. Deleting Fluent code that was installed generates delete
  records; see the SDK's `fluent-overview` before removing metadata.

### Where a Fluent record goes

`src/fluent` is grouped by feature, so that what changes together sits together: a feature's folder
holds its tables, its rules, UI actions, events, jobs, properties and REST messages, its ACLs, its
forms, lists, navigator modules, record producers and pages, and its ATF tests. The folders are
`agreements`, `orders`, `staging`, `warehouse`, `delivery` (shipments and field work), `in-service`,
`fleet` (what the app puts on the platform's hardware table: stage rules, substatus choices, ACLs),
`models`, `oem`, `break-fix`, `returns`, `disposal`, `assurance`, `racks`, `leases`, `billing`,
`margin` and `operations` (job cursors and locks, the settings every job reads, the preflight check,
the demo data loader).

- A new record goes to the feature whose table or server module it serves, whatever table it is
  declared on: the rule on `alm_hardware` that makes the lessor own a leased Asset is in `leases/`,
  not `fleet/`. A feature of a handful of records joins its nearest neighbour.
- A small feature is one file, `<feature>/<feature>.now.ts`. Past about 300 lines it is cut by kind:
  `tables.now.ts`, `logic.now.ts` (rules, UI actions, events with their script actions and
  notifications, jobs, properties, REST messages), `access.now.ts` (ACLs) and `forms.now.ts` (forms,
  lists, navigator modules, record producers, a page with its ACL). ATF tests are `tests.now.ts`.
- `shared/` holds what the SDK takes as one call for everything, and what no single feature owns:
  the roles and role groups, the cross-scope privileges, the columns added to platform tables (one
  `Table({ augments })` per table, whichever feature a column serves), the REST API (one `RestApi`
  with every route) and the ACL that admits customer users to it, the entry modules' installed path,
  the menu root with its separators (a feature's navigator modules are in its folder and name the
  root), the visibility rules and row checks with their ATF tests (ADR 0005: one concern over every
  scoped table), the customer page (it reads several features) and the ATF suites (one per delivery
  phase, each listing tests of several features).
- `workspace/` holds the workspace, its list menu and its dashboard: each is one structure over
  every table.
- A record's sys_id is keyed by its `$id` name in `generated/keys.ts`, not by its file: moving a
  record to another file changes nothing in the build.

## Verify on an instance

What only an instance or a vendor login can confirm (the install log and preflight, platform
choices, cross-scope access and purchase orders, the platform's Model lifecycle table and the fields
that replaced the app's own, running ATF, the Fleet flag and the clean-up after an upgrade,
stockroom assignment, visibility, row checks and REST access, the rules' refusals, on-site work
links, transfer orders, every job lock, rack re-checks, vendor contracts) is listed by area in
[docs/verify-on-instance.md](docs/verify-on-instance.md). Work through it on the first install and
after upgrading an instance where an earlier version was installed.
