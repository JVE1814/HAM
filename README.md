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
| Sourcing | Hot spare at the site (replacements) → customer spare pool → central stock (transfer to staging) → purchase order; daily spare-pool top-up |
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
| Leases | Lease schedules make their assets lessor-owned; mismatch alerts when a lease ends before the service; end-of-lease decisions (buy out, extend, return) ([spec](docs/spec/p3-contracts.md)) |
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
| `x_daas_ham.job.batch_size` / `.budget_seconds` | chunked-job tuning (defaults 500 / 120 s) |
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
| `x_daas_ham.shipping.*` | shipping aggregator: `enabled`, `api_key`, `webhook_token`, `service_code`, `package_kg`, `sender_name` |
| `x_daas_ham.oem.claim.<vendor>.enabled`, `.max_calls`, `x_daas_ham.checkpoint.api_key` | OEM claims, see [integrations spec](docs/spec/p3-integrations.md) |

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
Responds `202` with accepted / unknown identifiers / rejected rows. Only state changes are stored.

**Imports**: load CSVs into *ASN import rows* (`x_daas_ham_asn_import`, including MAC address and
OEM claim code), *Lifecycle import rows* (`x_daas_ham_eox_import`) and *OEM coverage import rows*
(`x_daas_ham_coverage_import`, optionally with the contract's annual cost) with System Import Sets >
Load Data; each row is processed on insert and its import state/comment shows the outcome.

**Billing pull API** (role `x_daas_ham.finance` or `x_daas_ham.integration`):
`GET /api/x_daas_ham/naas/billing_periods` and
`GET /api/x_daas_ham/naas/billing_periods/{id}/lines?offset=0&limit=1000` (`final` once the period is
closed, `nextOffset` null on the last page).

**Shipping aggregator**: labels through the *NaaS Shipping aggregator* REST message (ShipEngine label
API). Register the tracking webhook at
`https://<instance>/api/x_daas_ham/naas/shipping/tracking?token=<x_daas_ham.shipping.webhook_token>`;
ShipEngine and EasyPost payloads are accepted.

**OEM clouds**: REST messages *NaaS Meraki Dashboard*, *NaaS HPE Mist*, *NaaS HPE GreenLake*,
*NaaS FortiCare*, *NaaS FortiZTP* and *NaaS Check Point Zero Touch*. Attach OAuth 2.0 profiles to
GreenLake, FortiCare and FortiZTP; Meraki, Mist and Check Point take keys from password2 properties.
Each customer's org / subscription / FortiManager / template is an *OEM cloud account* record.

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

These cannot be checked without an instance:

- `sys_choice` records for `alm_asset.substatus` from a scoped app (ADR 0002).
- Cross-scope writes to `alm_hardware`, `change_request`, `wm_order`, `proc_po` (privileges are in
  `security/cross-scope.now.ts`; adjust target scopes if the instance reports different ones).
- Procurement field names used by `platform/procurement.ts` (`proc_po.status`, `ship_to`,
  `proc_po_item.ordered_quantity`).
- FSM work-order state 3 = Closed Complete and the `expected_start` / `estimated_end` fields.
- CI `last_discovered` / `discovery_source` as written by your connectors.
- Before-query rule performance at your data volumes (indexes are declared on the scoped columns).
- `wm_order.closed_at`, `company` and `location` for field-labour cost facts; `alm_asset.cost` as the
  purchase cost.
- Currency of the billing exports (amounts are written in each line's currency, default EUR).
- OEM claim endpoints and payloads against each vendor's current API (recorded fixtures in
  `domain/oem/claims.test.ts`); the Check Point Zero Touch endpoint in particular.
- That the shipping aggregator account accepts the configured `service_code` and depot address.
