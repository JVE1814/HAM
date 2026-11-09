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
| Ordering | "Request network equipment" record producer → Order + lines (site templates and single devices); entitlement check against the customer's catalog entries and contracted quantities; approvals by customer admins / account manager |
| Sourcing | Hot spare at the Order's site (replacements) → customer spare pool → central stock (transfer to staging) → purchase order; daily spare-pool top-up |
| Fleet | Every Asset the app creates or receives joins the fleet; *Add to fleet* adopts equipment the Provider already runs; rules, jobs, lists, dashboards and the app's ACLs act on fleet assets, NaaS stockrooms and NaaS Models only |
| Inbound | ASN import (in-transit assets), warehouse scanning app (receive, provider tags + labels, put-away, pick) |
| Staging | Staging tasks with per-customer / vendor / device-class checklists; distributor-staged units get a verification checklist |
| Delivery | Ship → change request + FSM work order (inside change and site maintenance windows); self-install confirmation |
| In service | Seen signals from Discovery / connectors (CI last discovered) and the provider NMS (REST) put installed assets in service and start their subscription line |
| Models | Normalization of discovered models (PID, aliases, match rules, exceptions that teach rules); lifecycle (EoX) dates via CSV; lifecycle phase and refresh due date per asset |
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

See [`docs/spec`](docs/spec) for the behaviour of each module. AI assistance is deferred (plan D68).

## Required plugins

Fluent cannot declare plugin dependencies, so check these before installing. After install, run the
on-demand job **NaaS - preflight check** (System Definition > Scheduled Jobs); its result is in
*NaaS Asset Management > Administration > Background jobs* (`preflight`).

| Capability | Plugin / product | Used for |
|---|---|---|
| Asset Management | base platform | `alm_hardware`, stockrooms, transfer orders |
| Procurement | `com.snc.procurement` | purchase orders (`proc_po`, `proc_po_item`) |
| Customer Service Management | CSM (`com.sn_customerservice`) | `customer_account`, `customer_contact`, cases (P2), portal (P2) |
| Field Service Management | FSM (`com.snc.work_management`) | `wm_order` work orders |
| Change Management | ITSM | `change_request` (standard changes for routine work) |
| Discovery / Service Graph Connectors | ITOM | CI `last_discovered` as a Seen signal |

Roles the app's roles contain and that must exist: `asset`, `inventory_user`, `inventory_admin`,
`procurement_user`, `procurement_admin`, `report_user`, `snc_external`, `canvas_user`. The app also
grants Customer Service's `sn_customerservice_agent` (the service desk) directly, in its ACLs, the
*Submit* and *Raise replacement* buttons and the request and return menu modules, so it must exist
too. The preflight check looks for all nine.

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

The install log lists eight expected *Skipped Error* rows; any other is a defect
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
`.finance`, `.admin`; customers: `.customer_admin`, `.site_contact`) and add inventory techs to
stockrooms (*Administration > Stockroom members*).

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
no Asset has its serial sees every Asset, past the importer's stockroom rule.

**Billing pull API** (role `x_daas_ham.finance` or `x_daas_ham.integration`):
`GET /api/x_daas_ham/naas/billing_periods` and
`GET /api/x_daas_ham/naas/billing_periods/{id}/lines?offset=0&limit=1000` (`final` once the period is
closed, `nextOffset` null on the last page). Each line carries its `currency`, and a period its
`totals`, one per currency: there is no single `total`, as two currencies are never added
([billing spec](docs/spec/p3-billing.md)).

The NMS and billing integrations sign in as an internal user, one without the `snc_external` role
(the Explicit Roles plugin gives such a user `snc_internal`). Their routes, like the warehouse ones,
require `snc_internal` and the platform's *Scripted REST External Default* ACL. Only the site, rack
and `/customer/...` routes admit customer admins and site contacts (`security/rest-acls.now.ts`).
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
| `npm test` | Vitest unit tests for the domain core and client helpers |
| `npm run build` | `now-sdk build` (Fluent type check, client bundle, app package) |
| `npx now-sdk cicd testsuite run ...` | ATF suites **NaaS - P1**, **NaaS - P2** and **NaaS - P3** on an instance (`src/server/atf-scripts.test.ts` checks their server-side scripts beforehand; [running ATF](docs/verify-on-instance.md#running-atf)) |

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
- The name of a business rule, UI action, script action, notification, SLA, REST message or REST
  route fits the instance's 40 characters, which cut a longer one off unseen
  (`record-names.test.ts`).
- Substatus values added to `alm_asset` live in `domain/lifecycle.ts` and
  `fluent/data/substatus-choices.now.ts` (`substatus-choices.test.ts` keeps them in sync).
- Commit `src/fluent/generated/keys.ts`. Deleting Fluent code that was installed generates delete
  records; see the SDK's `fluent-overview` before removing metadata.

## Verify on an instance

What only an instance or a vendor login can confirm (the install log and preflight, platform
choices, cross-scope access and purchase orders, running ATF, the Fleet flag and the clean-up after
an upgrade, visibility, row checks and REST access, the rules' refusals, transfer orders, every job
lock, rack re-checks, vendor contracts) is listed by area in
[docs/verify-on-instance.md](docs/verify-on-instance.md). Work through it on the first install and
after upgrading an instance where an earlier version was installed.
