# NaaS Hardware Asset Management (`x_daas_ham`)

A ServiceNow scoped application, written with the ServiceNow SDK (Fluent), that gives a
**Network-as-a-Service provider** HAM-style hardware asset management for the switches, access points,
routers and firewalls it installs at customer sites and bills as a service.

- Plan of record: [`plan.md`](plan.md) (design decisions D1–D76 and phasing).
- Domain language: [`CONTEXT.md`](CONTEXT.md). Architecture decisions: [`docs/adr/`](docs/adr).
- Behaviour per module: [`docs/spec/`](docs/spec).

## What it does

| Area | Phase 1 (this release) |
|---|---|
| Ordering | "Request network equipment" record producer → Order + lines (site templates and single devices); entitlement check against the customer catalog and contracted quantities; approvals by customer admins / account manager |
| Sourcing | Hot spare at the Order's site (replacements) → customer spare pool → central stock (transfer to staging) → purchase order; daily spare-pool top-up |
| Inbound | ASN import (in-transit assets), warehouse scanning app (receive, provider tags + labels, put-away, pick) |
| Staging | Staging tasks with per-customer / vendor / device-class checklists; distributor-staged units get a verification checklist |
| Delivery | Ship → change request + FSM work order (inside change and site maintenance windows); self-install confirmation |
| In service | Seen signals from Discovery / connectors (CI last discovered) and the provider NMS (REST) put installed assets in service and start their subscription line |
| Models | Normalization of discovered models (PID, aliases, match rules, exceptions that teach rules); lifecycle (EoX) dates via CSV; lifecycle phase and refresh due date per asset |
| Visibility | Customer admins see only their customer, site contacts their sites, inventory techs their stockrooms |
| UI | NaaS Asset Workspace (`/now/naas-assets/home`) with dashboard; navigator menu; warehouse page (`x_daas_ham_warehouse.do`) |

| Area | Phase 2 |
|---|---|
| OEM data | EoX and coverage from Cisco, Meraki, Fortinet and HPE Mist APIs; CSV for Aruba and Check Point; Cisco RMA status ([spec](docs/spec/p2-oem.md)) |
| Break-fix | Case → *Raise replacement* (hot spare, spare pool, stock, OEM advance replacement or purchase); replacement SLAs on the case |
| Returns | Decommission / removal requests, swap-backs, agreement-end and temporary-end returns; depot receipt and evaluation; overdue escalation, missing and fees |
| Refresh | Automatic refresh orders per agreement and site with successor-model choice |
| Disposal | Approved disposal orders retiring wiped assets by method and legal owner |
| Assurance | Blind counts, site audits, customer attestation, monitoring reconciliation exceptions |
| Racks | Placement guard and rack elevation page (`x_daas_ham_racks.do`) |
| Customer self-service | `x_daas_ham_customer.do`: equipment, faults, returns, install confirmation, attestation |

| Area | Phase 3 |
|---|---|
| Leases | Lease schedules make their assets lessor-owned; mismatch alerts when a lease ends before the service; end-of-lease decisions (buy out, extend, return; one buy out or return per lease, returned stock withdrawn to pending wipe and swapped-back units evaluated into wiping, not stock) ([spec](docs/spec/p3-contracts.md)) |
| Renewals | Agreement renewal warnings and *Renew agreement*; OEM coverage expiry warnings per customer |
| Billing | Service intervals per asset; monthly billing periods prorated by day (site packages) and device-day (per-device lines) plus fees; review, regenerate, close and lock; CSV attachment and pull API ([spec](docs/spec/p3-billing.md)) |
| Margin | Cost facts (purchase write-off, lease, OEM support, field labour) and margin per customer and site on period close; dashboard tab |
| Shipping | Labels bought through a shipping aggregator at *Ship* and for ship-back returns; tracking webhooks ([spec](docs/spec/p3-integrations.md)) |
| OEM claims | Staging steps done by the OEM cloud: Meraki and Mist claim, GreenLake device add and subscription, FortiCloud registration and FortiZTP, Check Point Zero Touch |
| Racks | Power budget per rack from model typical power |

See [`docs/spec`](docs/spec) for the behaviour of each module. AI assistance is deferred (plan D68).

## Required plugins

Fluent cannot declare plugin dependencies, so check these before installing. After install, run the
on-demand job **NaaS - preflight check** (System Definition > Scheduled Jobs); its result is in
*NaaS Asset Management > Administration > Background jobs* (`preflight`).

| Capability | Plugin / product | Used for |
|---|---|---|
| Asset Management | base platform | `alm_hardware`, stockrooms, transfer orders |
| Procurement | `com.snc.procurement` | purchase orders (`proc_po`, `proc_po_item`) |
| Customer Service Management | CSM | `customer_account`, `customer_contact`, cases (P2), portal (P2) |
| Field Service Management | FSM | `wm_order` work orders |
| Change Management | ITSM | `change_request` (standard changes for routine work) |
| Discovery / Service Graph Connectors | ITOM | CI `last_discovered` as a Seen signal |

Roles the app's roles contain and that must exist: `asset`, `inventory_user`, `inventory_admin`,
`procurement_user`, `procurement_admin`, `report_user`, `snc_external`, `canvas_user`,
`sn_customerservice_agent`.

## Install

```bash
npm install
npm run check                      # typecheck, lint, unit tests, build
npx now-sdk auth --add <alias>     # once per instance
npx now-sdk install --auth <alias> # add --demo-data on dev/test instances only
```

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
`.finance`, `.admin`; customers: `.customer_admin`, `.site_contact`) and add inventory techs to
stockrooms (*Administration > Stockroom members*).

### Demo data

With `--demo-data`, the on-demand job **NaaS - load demo data** is installed. Run it once
("Execute Now"): it creates two customers (Acme Retail, Globex Logistics) with sites, racks and
stockrooms, models from Cisco/Meraki, HPE Aruba, Fortinet and Check Point, site templates, agreements,
subscription lines, catalog entries, staging checklists, demo users (`naas.inventory`, `naas.field`,
`acme.admin`, `acme.hq.contact`) and stock, in-service switches with OEM coverage, service intervals
and a lease that ends before the Acme agreement, and sets the two properties above. Lifecycle dates in the
demo data are illustrative, not vendor bulletins.

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
rejected rows. Only state changes are stored.

**Imports**: load CSVs into *ASN import rows* (`x_daas_ham_asn_import`, including MAC address and
OEM claim code), *Lifecycle import rows* (`x_daas_ham_eox_import`) and *OEM coverage import rows*
(`x_daas_ham_coverage_import`, optionally with the contract's annual cost) with System Import Sets >
Load Data; each row is processed on insert and its import state/comment shows the outcome.

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
- Substatus values added to `alm_asset` live in `domain/lifecycle.ts` and
  `fluent/data/substatus-choices.now.ts` (`substatus-choices.test.ts` keeps them in sync).
- Commit `src/fluent/generated/keys.ts`. Deleting Fluent code that was installed generates delete
  records; see the SDK's `fluent-overview` before removing metadata.

## Verify on the first install

The vendor and platform contracts were checked against primary documentation
([docs/research/external-contracts.md](docs/research/external-contracts.md)) and the code follows it.
What remains can only be confirmed on an instance or behind a vendor login:

- **Choices**: the instance accepts the app's `alm_asset.substatus` choice set (v2 format, only the
  app's 12 values) and none of them collides with an out-of-box value; check
  `sys_choice name=alm_asset^element=substatus^dependent_value=6` for an existing *Pending evaluation*
  before the first install, and if it exists drop the app's `pending_evaluation` choice (and its
  `keys.ts` entry) and map the stage to the out-of-box value.
- **Cross-scope access**: the privileges in `security/cross-scope.now.ts` match the scopes the instance
  reports (`alm_hardware`, `change_request`, `wm_order`, `proc_po`, `sys_attachment`, ...), including
  delete on `alm_transfer_order`, its lines and `proc_po`, which sourcing uses to remove a transfer order
  or purchase order created only in part (otherwise the line's sourcing summary names it for cancelling).
- **Procurement and FSM data**: the stored `proc_po` / `proc_po_item` status values and column names,
  `wm_order` state 3 = Closed Complete, and `last_discovered` / `discovery_source` as your connectors
  write them.
- **REST messages**: that `${meraki_host}` / `${mist_host}` substitute inside the endpoint host
  (otherwise use `setEndpoint`), that the GreenLake `find_device` filter URL is accepted, and that the
  Fortinet OAuth profiles (password grant, no client secret) obtain tokens for FortiCare and FortiZTP.
- **Vendor-login-only contracts**: FortiCloud `products/register` and FortiZTP provisioning schemas
  (FNDN), Cisco API quotas (API Console), and whether ShipEngine labels are tracked automatically or
  need `/v1/tracking/start`.
- **Job lock** (margin recomputes, ADR 0013): *Job lock* shows a unique database index on *Lock*; a
  second row with the same name is refused (`GlideRecord.insert()` returns no sys_id) without
  throwing, and the `x_daas_ham.margin.compute` event still ends as processed (a refused take tries
  the insert twice, before and after clearing abandoned locks, so two *Unique Key violation* errors in
  the system log per refused take are expected, three when the holder lets go between the second try
  and the check that follows and another take wins the third try; a third try that is accepted takes
  the lock); a lock row created over 10 minutes ago is cleared by the next recompute and a fresh one
  is not; a chunk that finds the lock held runs again about a minute later; a recompute whose lock was
  cleared while it was writing logs a *job lock lost while writing* warning and starts a fresh pass,
  which recomputes the period from scratch; and no lock row is left once a recompute completes.
- **Provider tag counter** (warehouse Receive): the counter is advanced under the job lock
  `provider_tag_sequence`, so two units received at the same moment get different tags. A receipt that
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
- **Stock reservation lock** (Order sourcing, the spare-pool top-up and receiving's reservation for a
  waiting line): reserving an Asset for an Order line, linking a hot spare at the customer site to
  one, or moving free stock into a Spare pool takes the job lock `reserve_asset_<Asset sys_id>` in the
  same *Job lock* table and re-reads the Asset under it, so two runs that pick the same Asset never
  both claim it. The re-read also refuses a unit whose lease is being returned to its Lessor (end
  action *Return to lessor*), so such a unit is never reserved, linked or pooled. The run that finds
  the lock held leaves that Asset to the other (the unit counts in its line's or pool's shortfall) and
  logs two *Unique Key violation* errors, or one when the other run lets go in between and the re-read
  finds the Asset taken, or three when the other run lets go between the second try and the check
  that follows and another run wins the third try; no `reserve_asset_` lock row is left once the run
  ends. A lock that cannot be taken for another reason logs
  *[x_daas_ham] Asset <id> not claimed: job lock ... could not be taken*, and a claim that outlasts its
  lock and gives the Asset up logs *[x_daas_ham] Asset <id> not claimed: its lock was lost while
  claiming it*. A receipt whose reservation finds the unit taken logs *[x_daas_ham] Received <serial>
  not reserved for <line>: another run claimed it, or the save was refused*.
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
- **Sourcing locks** (Order sourcing and receiving): a sourcing pass holds the job lock
  `source_order_<Order sys_id>` for its whole run, and reads and saves each line under
  `order_line_<line sys_id>`, which a receipt for a waiting line takes too. A pass that finds the
  Order's lock held logs two *Unique Key violation* errors and *[x_daas_ham] <Order> sourced again in
  60 s: another pass holds its lock* (info), and runs again a minute later. A request queued again 15
  times logs *[x_daas_ham] <Order> not sourced again after 15 tries (...): check its lines* (warning)
  and is dropped. A line lock is tried 10 times, each refused try logging two errors (up to 20). Held
  through them all, sourcing leaves the line to the pass queued again (after picking stock, it logs
  *[x_daas_ham] <line> left to the next sourcing pass (...)*, naming any transfer orders the line does
  not list), and a receipt answers HTTP 503 *Its order line is being sourced or received: scan again*
  and saves nothing. A received unit whose reservation fails queues `x_daas_ham.order.source` for its
  Order: one *not reserved for <line>* warning is followed by a sourcing pass, not by a stalled line.
  No `source_order_` or `order_line_` row is left once a run ends.
- **Serial lock** (warehouse Receive without an ASN): the first scan of an unknown serial with its PID
  creates the Asset under the job lock `receive_serial_<serial>`, checking there that no Asset has the
  serial, so two first scans create one Asset. The other answers HTTP 503 *Another scan is receiving
  this unit: scan again* and logs two *Unique Key violation* errors; its rescan finds the Asset by
  serial. No `receive_serial_` row is left once the receipt ends.
- **Return label and Ship locks**: *Create return label* holds the job lock
  `return_label_<Return order sys_id>` while it checks for an open label and buys one. A second press
  while one is being bought says *A return label is already being bought for this return* and buys
  nothing. *Ship* holds `ship_order_<Order sys_id>`: a second Ship says *Another Ship of this Order is
  running* and ships, buys and opens nothing. Each refused take logs two *Unique Key violation*
  errors, and no lock row is left afterwards.
- **Inventory tech access** (ADR 0005), also after upgrading an existing install: the ACLs that
  `security/acls*.now.ts` give `broadStaff` (agreements, subscription lines, catalog entries, site
  templates, fee events, attestations, leases, OEM coverage and cloud accounts, model data, device
  events, reconciliation exceptions, stockroom members, ...) no longer list `x_daas_ham.inventory_tech`
  in `sys_security_acl_role`. Impersonating an inventory-tech-only user, the Agreements list is denied,
  other stockrooms' blind counts and site audits are not listed, and in the warehouse app receiving one
  returned unit of a multi-unit site package keeps its subscription line active, receiving the last one
  ends it, and a late one records the late-return fee.
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
- **Order create rule in jobs**: an Order is submitted only when its user passes the Order create rule
  (`GlideRecord.canCreate()`). The daily job *NaaS - raise refresh orders* relies on its *Run as* user
  (expected to be the system user) passing it; one without an Order raiser role leaves its refresh
  Orders as drafts with the work note *You may not raise orders*.
- **Scale**: before-query rule performance and the chunked jobs at your data volumes (indexes are
  declared on the scoped columns).
- **Currency**: amounts are written in each line's currency (default EUR); confirm the session
  currency of the job user if you bill in several currencies.
