# x_daas_ham — Hardware Asset Management for a NaaS Provider (ServiceNow Fluent)

> Status: **Phases 1–3 built** (AI deferred, D68); the instance-only checks are listed in
> [`docs/verify-on-instance.md`](docs/verify-on-instance.md). This document is the outcome of a
> structured design interview (76 questions, recorded in the [Decision log](#20-decision-log)). It is
> the plan of record for building the app. Each module gets its own written spec in `docs/spec/`
> before it is built. Where this plan and the code differ, the ADRs and `docs/spec/` are current;
> §5 and §18–§20 are kept as written.

---

## Table of contents

1. [Summary](#1-summary)
2. [Business context](#2-business-context)
3. [Goals, non-goals and deferrals](#3-goals-non-goals-and-deferrals)
4. [Platform, licensing and dependencies](#4-platform-licensing-and-dependencies)
5. [Research findings](#5-research-findings)
6. [Architecture principles](#6-architecture-principles)
7. [Personas and roles](#7-personas-and-roles)
8. [Security and visibility model](#8-security-and-visibility-model)
9. [Data model](#9-data-model)
10. [Asset state model](#10-asset-state-model)
11. [Phase 1 — Foundation and core lifecycle](#11-phase-1--foundation-and-core-lifecycle)
12. [Phase 2 — Lifecycle processes](#12-phase-2--lifecycle-processes)
13. [Phase 3 — Contracts, money and integrations](#13-phase-3--contracts-money-and-integrations)
14. [User experience](#14-user-experience)
15. [Integrations](#15-integrations)
16. [Performance and scale](#16-performance-and-scale)
17. [Repository layout and conventions](#17-repository-layout-and-conventions)
18. [Testing, quality gates and delivery](#18-testing-quality-gates-and-delivery)
19. [Risks and known unknowns](#19-risks-and-known-unknowns)
20. [Decision log](#20-decision-log)

---

## 1. Summary

We are building **`x_daas_ham`**, a ServiceNow scoped app written with the **ServiceNow SDK (Fluent)**.
It gives a Network-as-a-Service (NaaS) provider the core features of ServiceNow Hardware Asset
Management (HAM, formerly "HAM Pro"), reworked for managed network equipment at customer sites. It
does not need a HAM or "DaaS for HAM" subscription.

- **Devices:** switches, wireless access points, routers and firewalls from Cisco (including Meraki),
  HPE (Aruba, Mist, GreenLake), Fortinet and Check Point.
- **Lifecycle covered:** customer agreement → site order → sourcing → receiving → staging →
  delivery and install → in-service and billing → break-fix → refresh → return → disposal.
- **Built on:** the platform's own asset tables plus CSM, FSM, Change, Procurement, Discovery /
  Service Graph Connectors and Performance Analytics. Our own tables exist only for concepts that
  are new.
- **Delivered in three phases** (P1 foundation and core lifecycle, P2 lifecycle processes,
  P3 contracts, money and integrations). Code ships as a foundation PR followed by one PR per
  module.

## 2. Business context

- **Who we are:** a NaaS provider. Customers subscribe to network services, such as a site package
  or a per-device-class service. The provider supplies, installs, runs, replaces and refreshes the
  equipment.
- **Who owns the devices:** a mix. Some the provider owns outright, some are leased from financiers
  (e.g. Cisco Capital, HPE Financial Services, banks), and some belong to the customer but are
  managed by the provider.
- **Customers** are CSM accounts. Each has:
  - **sites**, organised as locations (site → building → room/MDF/IDF → rack);
  - **customer network/IT admins**, who order, see the installed base, raise faults, approve
    off-catalog requests and attest the inventory;
  - **site contacts**, who confirm deliveries and installs, and plug in or swap simple devices.
- **Stock** sits in central provider depots (some of it reserved as per-customer spare pools), in
  staging centres, and in stockrooms at customer sites (hot spares).
- **Monitoring:** the provider's NOC spots failures through monitoring and opens proactive cases.
  The customer can raise cases too.
- **Who does the work on site:**
  - provider FSM engineers;
  - subcontractors (through FSM);
  - the customer's own staff for zero-touch (ZTP) self-installs;
  - data-centre remote hands for rack-and-stack.

## 3. Goals, non-goals and deferrals

**Goals**
- Match HAM's *behaviour* (not its exact UI) for the core hardware lifecycle and stock management,
  reshaped for NaaS.
- Write it clean-room from public ServiceNow documentation. **No code or metadata is copied from
  `sn_hamp` or any other ServiceNow app.**
- Run on the latest GA family release only (currently **Brazil**) and follow each new release.
- Cope with **100k–1M hardware assets**.

**Won't build**
- ServiceNow Content Service data (HAM's hosted normalisation library and EoX dates).
- Zero Touch refresh/request (needs Service Exchange).
- Telecom Network Inventory, Zebra RFID, CAD indoor maps.
- HAM licensing/entitlement plumbing.
- Port- and cabling-level DCIM.
- HAM's "maturity / success portal" dashboard.
- Creating OEM RMAs through an API. No OEM offers an API for this (Juniper's Case API is the only
  partial exception), so RMAs are opened manually and their status is tracked.

**Deferred**
- **AI assistance.** We revisit this after P3. When we do, we use Now Assist custom skills
  (`NowAssistSkillConfig`, governed and metered), never direct LLM API calls.
- **Account-team-scoped visibility for provider staff.** This will be added per contract, only if a
  customer requires it.

**From the original "won't build" list, pulled back in by the user**
- Rack / data-centre visualisation (read-only elevation in P2, power budget in P3).
- A provider-side per-customer view, the NaaS equivalent of HAM's "DaaS provider view" (basic in
  P1, extended in P2).
- AI, which is deferred as described above.

## 4. Platform, licensing and dependencies

| Item | Decision |
|---|---|
| Family release | **Brazil** (instance is on Brazil). Additive `ChoiceSet` (`legacyChoices: false`) is available. |
| SDK | `@servicenow/sdk` **4.14.x** (latest at 2026-10-22), Node 20+. |
| Scope | **`x_daas_ham`**. Table names `x_daas_ham_*`. Columns added to base tables are prefixed `x_daas_ham_`. |
| Company model | Several companies, told apart by the `company` field (= customer account). **No domain separation.** |
| Licensed and used | CSM, FSM, ITSM Change, Procurement (`com.snc.procurement`), Performance Analytics, Discovery (MID), Service Graph Connectors. |
| Licensed, not used | HR Service Delivery (customer end users are not in scope; provider staff devices are not in scope). |
| Never touch | `sn_hamp_*`, `sn_itam_common_*`, `sn_daas_*` tables. Writing to them could count as licensed use. |
| Plugin dependencies | Fluent cannot declare them. They are listed in the README, and a preflight check script verifies the required plugins are active. |
| Delivery | The user installs manually with `now-sdk install` (dev → test → prod). No CI. |

### Existing ServiceNow connectors to reuse (do not rebuild)

- **SGC for Fortinet:** reads FortiManager through a MID Server; brings licence expiry dates.
- **HPE Mist:** Service Graph Connector plus Mist Automated Provisioning.
- **Meraki:** Service Graph Connector (telco SD-WAN variant). It has no EoX fields.
- **ServiceNow Discovery:** used for everything reachable over SNMP/SSH.

## 5. Research findings

Confidence tags:
- **[C]** confirmed in vendor or ServiceNow documentation;
- **[Cm]** community or third-party source;
- **[I]** inference.

### 5.1 ServiceNow HAM (Brazil, HAM 16.0.x)

- **Product naming.** "HAM Pro" is now a legacy name. Since April 2026 HAM is sold as
  **Foundation / Advanced / Prime** tiers. [C/Cm]
- **What base (free) Asset Management already gives us:** [C]
  - `alm_asset` / `alm_hardware` / `alm_consumable` and `cmdb_model`;
  - stockrooms, transfer orders, and purchase orders through Procurement;
  - `ast_contract`;
  - stock rules plus the daily "Stock Rule Runner" job;
  - asset↔CI sync and the `install_status` / `substatus` fields.
- **HAM-only features we can rebuild:**
  - workspace and dashboard;
  - model normalisation tables and rules;
  - lifecycle phases (Availability, End of sale, End of support, End of extended support, EOL);
  - deploy/swap/retire tasks;
  - refresh (request → refresh line → tasks);
  - reclamation (line stages Ready → Pending receive → Pending evaluation → Complete; tasks
    Schedule / Receive / Evaluate);
  - loaners;
  - disposal, resale and donation;
  - audits and attestation;
  - RMA and repair;
  - lease expiry and buyout/extension;
  - contract renewal;
  - put-away and pick tasks, unified receiving and ASN import;
  - bundles;
  - TCO;
  - optional checks on asset actions raised from incidents and changes.
- **Not reproducible:** Content Service data, Otto / Now Assist skills (they need entitlements),
  Zero Touch (needs Service Exchange), and licensing plumbing.
- **Rack views** belong to DCNAM / TNI, which are licensed separately. They are not part of HAM.

### 5.2 ServiceNow "DaaS for HAM" (`com.sn_daas_ham`) — used as a spec reference only

- **It is provider-side.** It describes itself as helping "DaaS providers manage assets from sourcing
  through disposal". [C]
- **Provider view:**
  - Problem widgets for assets that are missing an asset tag, serial number, DaaS account or
    stockroom.
  - For each customer account: open and unassigned tasks, shipment status, and assets past their
    refresh date.
- **Order stage models:**
  - **Inbound order:** Select → Pick → Prepare → Ship → Receive confirmation.
  - **RMA response:** Evaluate → Schedule shipment → Receive → Repair → Schedule refresh.
  - Repair order lines.
- The user decided to build anyway (Q37).

### 5.3 Fluent / ServiceNow SDK 4.14

- **Typed APIs we use:**
  - Data model: `Table` (50 column types, `extends`, **`augments`** to add `x_` columns to global
    tables, `index`), `OverrideColumn`, `Record`, `ChoiceSet`.
  - Server logic: `BusinessRule`, `ScriptInclude`, `ScriptAction`, `ScheduledScript`, `RestApi`,
    `RestMessage`, `Alias`.
  - Form behaviour and security: `ClientScript`, `UiAction`, `UiPolicy`, `DataPolicy`, `Acl`,
    `Role`, `CrossScopePrivilege`.
  - Configuration and navigation: `Property`, `ApplicationMenu`, `List`, `Form`.
  - Process: `Flow` / Subflow / Custom Action (catalog triggers, TryCatch, DoInParallel, stages),
    `CatalogItem`, `CatalogItemRecordProducer`, `VariableSet`, `EmailNotification`, `ImportSet`,
    `Sla`, `StateModel`, `DatabaseView`.
  - UI and reporting: `Workspace` (standard layout only), `Dashboard`, `UiPage` (React/Vite).
  - Testing: `Test` / `TestSuite` (ATF).
  - AI: `NowAssistSkillConfig` / `AiAgent` (deferred).
- **Gaps:**
  - Navigator modules → use `Record()`.
  - Custom UI Builder pages → not possible.
  - Plugin dependencies → not declarable.
  - CMDB identification rules and class metadata → outside Fluent.
- **Server modules:** TypeScript in `src/server` is built into `sys_module`. They can be called from
  BR / ScriptAction / UiAction / RestApi / RecordProducer / ScheduledScript. They **cannot** be
  called from ScriptInclude (without a `require` bridge), client scripts, UI policies or `Record`
  data.
- **Build behaviour:** `.now.ts` files are statically analysed, so no runtime loops or ifs in
  metadata. If an XML file in `metadata/` has the same key as Fluent code, the XML wins.
- **CLI commands:** `init`, `build --frozenKeys`, `install [--demo-data] [--reinstall]`, `transform`,
  `dependencies --add tables <t> --scope global`, `cicd testsuite run`, `pack`, `query`, `exec`.
- **SDK guidance:** commit `src/fluent/generated/keys.ts`. Don't customise vendor (`sn_*`) scopes;
  extend their tables from your own scope instead.

### 5.4 Racks and data centres in the base platform

- **Rack data:** `cmdb_ci_rack` holds "Rack units" and "Rack units in use", which are maintained by
  hand. `cmdb_model` has a "Height (U)" field (column name to be verified).
- **Device position:** there is **no base field for a device's position in a rack** and **no base
  visualisation**. We add RU start, face and rack reference ourselves, plus a "Rack contains"
  relationship.

### 5.5 Network OEM APIs

| Vendor | EoX dates | Coverage by serial | RMA | Claim / ZTP / licences |
|---|---|---|---|---|
| Cisco | ✅ EoX v5 (`apix.cisco.com`, ≤20 items/call) | ✅ SN2INFO v2 (≤50/page) | Lookup only (Service Order Return API) | ❌ PnP has no public API (auto-registration through Smart Account on order) |
| Meraki | ✅ `inventory/devices` eox fields (not in service-provider orgs) | ❌ (licence expiry only) | ❌ | ✅ `inventory/claim` (10 calls / 5 min / IP) |
| HPE Aruba | ❌ (web pages) | ❌ | ❌ | ✅ GreenLake Platform API (device add + subscription assign, OAuth) |
| HPE Mist | ✅ JSI inventory eol/eos [I] | ✅ JSI warranty fields [I] | Case API (needs onboarding) | ✅ claim API (token, 5,000/h) |
| Fortinet | ⚠️ unclear fields | ✅ Asset Management API v3 (IAM API user; 100/min, 1,000/h) | ❌ | ✅ registration + FortiZTP |
| Check Point | ❌ (Support Life Cycle page) | ❌ | ❌ | ⚠️ Zero Touch cloud REST API |

- **Access notes:**
  - Cisco Support APIs use OAuth2 client credentials (`id.cisco.com`) and require an SNTC or PSS
    entitlement.
  - Avoid the CX Cloud API: CX Cloud reached end of availability in August 2026.
- **The user has access to:** Cisco SNTC/PSS, a Meraki non-SP org, a Fortinet IAM API user,
  HPE Mist and an HPE GreenLake workspace.

### 5.6 AI (deferred, for reference)

- **SDK guidance:** use `NowAssistSkillConfig` skills, and do not call `sn_generative_ai.LLMClient`
  directly.
- **Entitlement:** needs AppEngine / AI Platform. Since April 2026, assists are reportedly metered
  across tiers. [Cm]
- **Bring your own model:** possible through the Generic LLM connector (skills only). Claude is
  available as "Anthropic Claude via AWS".

### 5.7 Key sources

- HAM:
  - https://www.servicenow.com/docs/r/it-asset-management/hardware-asset-management/installed-with-ham.html
  - https://www.servicenow.com/docs/r/release-notes/hardware-asset-management-rn.html
  - https://www.servicenow.com/docs/r/it-asset-management/hardware-asset-management/reclaim-asset.html
  - https://www.servicenow.com/docs/r/it-asset-management/hardware-asset-management/loaner-asset.html
  - https://www.servicenow.com/docs/r/it-asset-management/hardware-asset-management/hardware-normalization.html
  - https://www.servicenow.com/docs/r/it-asset-management/asset-management/c_StockRules.html
- DaaS for HAM:
  - https://www.servicenow.com/docs/r/store-release-notes/store-rn-itam-hardware-asset-mgmt-daas.html
- SDK:
  - https://servicenow.github.io/sdk
  - https://github.com/ServiceNow/sdk
  - https://github.com/ServiceNow/sdk-examples
- OEM:
  - https://developer.cisco.com/docs/support-apis/eox/
  - https://developer.cisco.com/meraki/api-v1/get-organization-inventory-devices/
  - https://developer.greenlake.hpe.com/docs/greenlake/services/device-management/public
  - https://www.mist.com/documentation/api-rate-limiting/
  - https://community.fortinet.com/t5/FortiCloud-Products/Technical-Tip-API-how-to-retrieve-list-of-registered-units-for/ta-p/194760
  - https://www.checkpoint.com/support-services/support-life-cycle-policy/

## 6. Architecture principles

1. **Base tables are the system of record.**
   - Devices live in `alm_hardware`. Their state lives only in `install_status` / `substatus`.
   - We add columns to base tables with `Table({ augments })`.
   - We create scoped tables only for new concepts. New process tables extend `task`, so they get
     assignment, approvals, SLAs, activity and the workspace for free.
2. **Hybrid logic.**
   - Flows run the human-facing process: approvals, FSM, Change, notifications, waits.
   - TypeScript server modules hold the domain rules. They are pure functions where possible and
     are unit-tested.
   - Business rules and flows are thin wrappers that call those modules.
3. **Bulk work is always chunked** through one shared helper (see §16). Nothing does a full-table
   scan inside a synchronous transaction.
4. **One source of truth per fact.** No second lifecycle field, no copies of customer or company
   data. Summary fields are allowed only when documented as derived caches with a defined refresh
   path.
5. **Vendor-agnostic core, vendor-specific adapters.** OEM integrations implement one interface, and
   so do the "device seen" sources.
6. **Integrate, don't re-implement.** We use CSM cases, entitlements and SLAs; FSM work orders;
   Change; Procurement; Discovery and SGCs; PA.
7. **Specs come before code.** `docs/spec/<module>.md` is derived from the public docs and from this
   plan, and the tests are written against it.

## 7. Personas and roles

| Role | Persona | Contains (base roles, verify names in PR 1) | Main surfaces |
|---|---|---|---|
| `x_daas_ham.admin` | App administrator | all app staff roles, `inventory_admin`, `procurement_admin` | Workspace, config |
| `x_daas_ham.asset_manager` | Provider asset manager | `asset`, `inventory_user`, `procurement_user`, `model_manager`, `report_user`, and the inventory tech and NOC roles | Workspace (all) |
| `x_daas_ham.inventory_tech` | Depot / staging centre technician | `asset`, `inventory_user` | Warehouse scanning app, Workspace (stock, staging) |
| `x_daas_ham.field_tech` | FSM field engineer (on top of FSM roles) | `asset` (read and update deployed assets) | FSM mobile; scan page for site audits |
| `x_daas_ham.account_manager` | Customer account owner | `asset` (read) | Approves over-quota requests; owns agreements, site templates and customer catalogs |
| `x_daas_ham.finance` | Finance / billing | `report_user` | Subscription lines, billing periods (P3), margin (P3) |
| `x_daas_ham.noc` | Network operations centre | `asset` (read) | Opens proactive cases; sees installed base, coverage and EoX |
| `x_daas_ham.customer_admin` | Customer network/IT admin | `snc_external` | CSM portal: installed base, orders, faults, decommission, attestation |
| `x_daas_ham.site_contact` | Customer site contact | `snc_external` | CSM portal: confirm delivery/install, self-install, swap simple devices, ship-back |

## 8. Security and visibility model

- **Provider staff:**
  - All staff see **every customer**.
  - `inventory_tech` is limited to **their assigned stockrooms**: stock, transfer orders, staging,
    receiving and audits. A tech's stockrooms are those whose platform *Assignment group* they are a
    member of (ADR 0018).
- **Customer contacts:**
  - They see only records whose account matches their own CSM account.
  - Site contacts are further limited to their assigned site(s).
- **How it's enforced:**
  - Before-query business rules add indexed filters (`company`, `x_daas_ham_customer`,
    `stockroom`, `x_daas_ham_site`; `customer` and `site` on the app's own tables). This avoids
    "rows removed by security constraints" and slow lists at 1M rows.
  - ACLs back up every table and field. External contacts get explicit `snc_external` ACLs.
- **Cross-scope:** we create `CrossScopePrivilege` records for every global table we read or write:
  - `alm_hardware`, `alm_asset`, `alm_stockroom`, `alm_transfer_order(_line)`;
  - `cmdb_model`, `cmdb_model_lifecycle`, `cmdb_ci_*`, `cmn_location`, `cmn_schedule`, `ast_contract`;
  - Procurement tables;
  - `change_request`;
  - `wm_order`;
  - CSM case, `customer_account` and `customer_contact`.
- **Data policies** protect key invariants:
  - a deployed asset must have an agreement and a site;
  - a leased asset cannot get a disposal method other than "return to lessor".

## 9. Data model

**Conventions:**
- Scoped tables are `x_daas_ham_<name>`. Columns we add to base tables are `x_daas_ham_<name>`.
- Each table is defined in the folder of the feature that owns it, `src/fluent/<feature>/` (README,
  *Where a Fluent record goes*).
- Field lists below are indicative. Each module spec finalises them, and the Fluent table
  definitions under `src/fluent` are the tables as built: they name the Customer `customer` where
  the lists below say account.

### 9.1 Base tables used (system of record)

| Concept | Table |
|---|---|
| Device (chassis, FRU, stack member) | `alm_hardware` (FRUs link to the chassis through `parent`) |
| SFPs, cables, small parts | `alm_consumable`, where the Model's platform asset tracking strategy says so (ADR 0018) |
| Model / product ID | `cmdb_model` / `cmdb_hardware_product_model` |
| Model lifecycle milestones (end of sale, support, extended support, life) | `cmdb_model_lifecycle` / `cmdb_hardware_model_lifecycle`: one row per Model and milestone (ADR 0017) |
| Customer | `customer_account` (extends `core_company`) |
| Customer person | `customer_contact` |
| Site / building / room | `cmn_location` (company = customer) |
| Rack | `cmdb_ci_rack` |
| Stockroom | `alm_stockroom` |
| Stock movement | `alm_transfer_order` / `alm_transfer_order_line` |
| Purchase order | Procurement `proc_po` / `proc_po_item` (verify) |
| Contracts | `ast_contract` |
| Case | CSM case table |
| Field work | FSM `wm_order` |
| Change | `change_request` (+ standard change templates) |
| Maintenance windows | `cmn_schedule` |

### 9.2 Columns added to base tables (`augments`)

| Table | Column (`x_daas_ham_` + …) | Type | Phase | Notes |
|---|---|---|---|---|
| `alm_hardware` | `legal_owner` | choice: provider / customer / lessor | P1 | Indexed |
| | `agreement` | ref `x_daas_ham_agreement` | P1 | Indexed |
| | `subscription_line` | ref `x_daas_ham_subscription_line` | P1 | Indexed |
| | `site` | ref `cmn_location` | P1 | Site-level location. The base `location` field may point to a room. |
| | `customer_tag` | string | P1 | Indexed; resolved by the scanner |
| | `staging_source` | choice: in-house / distributor | P1 | |
| | `in_service_date` | date/time | P1 | Starts billing |
| | `last_seen` | date/time | P1 | Derived cache from CI or device events. Indexed. |
| | `seen_source` | choice: discovery / sgc / nms | P1 | |
| | `rack`, `ru_start`, `rack_face` | ref `cmdb_ci_rack`, integer, choice | P1 (data) / P2 (view) | |
| | `lifecycle_phase` | choice: available / end_of_sale / end_of_support / end_of_extended_support / eol | P1 | Derived from the Model's milestones in `cmdb_model_lifecycle` |
| | `refresh_due` | date | P1 (field) / P2 (logic) | Indexed |
| | `coverage_end` | date | P2 | Derived from `oem_coverage` |
| `cmdb_model` | `device_class` | choice: switch / ap / router / firewall / module / psu / optic / other | P1 | Drives catalog, billing and KPIs |
| | `oem_pid` | string | P1 | Canonical vendor product ID. Indexed. |
| `alm_stockroom` | `stockroom_type` | choice: central depot / staging centre / customer site | P1 | |
| | `customer` | ref `customer_account` | P1 | For customer-site stockrooms |
| `cmn_location` | `maintenance_schedule` | ref `cmn_schedule` | P1 | Change scheduling |
| | `site_contacts` | glide_list `customer_contact` | P1 | |

### 9.3 Scoped tables — Phase 1

| Table | Extends | Key fields |
|---|---|---|
| `agreement` | `ast_contract` | account, term start/end, refresh_cycle_months, replacement_sla_tier, spare_pool_ratio, overdue_return_days, lost/damage fee rules, status |
| `agreement_quantity` | — | agreement, device_class or model, contracted_qty (for quota checks) |
| `subscription_line` | — | agreement, account, site, line_type (site package / device class), quantity, monthly_rate, currency, start_date (in-service), end_date, status |
| `catalog_entry` | — | account, model **or** site_template, monthly_rate, active, valid_from/to |
| `site_template` | — | name, account (blank = global), description, active |
| `site_template_item` | — | site_template, model or device_class, quantity, optional (bool), kit (optics/PSU) |
| `order` | `task` | order_type (site rollout / device add / device replace), account, site, agreement, install_mode, requested_date, ritm, approval_reason, stage |
| `order_line` | — | order, model, quantity, sourcing_result (reserved spare / central stock / PO), transfer_order, po_line, staging_task(s), fsm_work_order, change_request, stage |
| `staging_task` | `task` | asset, order_line, staging_source, checklist_template, firmware_target, verified_by, result |
| `staging_template` | — | account (optional), device_class / model family, vendor, items (child table `staging_tmpl_item`); a Staging task's own steps are `staging_step` rows |
| `manufacturer_alias` | — | alias_string, canonical manufacturer (`core_company`) |
| `model_match_rule` | — | order, manufacturer, pattern (regex / prefix / exact on PID or model name), canonical model, active |
| `asn_import` (import set staging) | `sys_import_set_row` | distributor, po_number, ship date, carrier, tracking, serial, PID, MAC, quantity |
| `device_event` | — | asset or CI, serial, event (seen / down / up), source, received_at. Stores **state changes only**, with a retention job. |
| `job_cursor` | — | job name, last processed key, last run, status (used by the chunked-job helper) |

### 9.4 Scoped tables — Phase 2

| Table | Extends | Key fields |
|---|---|---|
| refresh Order (an `order` of type `refresh`) | `task` | account, site, agreement, reason (cycle / EoX), assets (m2m), new order link, change_request, customer approval, return deadline |
| replacement Order (an `order` of type `device_replace`, linked from its case) | `task` | case (CSM), failed asset, replacement asset, source (site spare / depot / OEM advance replacement), fsm_work_order, change_request, oem_rma |
| `oem_coverage` | — | asset or serial, vendor, contract number, service level (e.g. 8x5xNBD, 24x7x4), start/end, source, last_checked |
| `oem_rma` | — | vendor, RMA number, replacement Order, defective asset, replacement serial, status (synced for Cisco), ship-back deadline |
| `return_order` / `return_order_line` | `task` / — | trigger (site decommission / device removal / refresh swap-back / agreement end / defective), account, site, assets, method (FSM de-install / site-contact ship-back), tracking, due date, received date, evaluation result |
| `fee_event` | — | asset, account, agreement, type (lost / damaged / late return), amount, date, billed_in_period |
| `disposal_order` / `disposal_line` | `task` / — | asset, method (broker resale / OEM takeback-trade-in / ITAD recycle / return to customer / return to lessor), wipe evidence (reset / zeroise / credential clear + certificate attachment), credit amount, certificate number, approvals |
| temporary Order (an `order` of type `temporary`) | `task` | account, site (event / pop-up / POC), start/end, assets, auto return_order |
| `audit` / `audit_line` | `task` / — | audit type (depot blind count / site audit), stockroom or site, expected vs scanned, discrepancy type, resolution |
| `attestation` / `attestation_item` | `task` / — | account, site, period, contact, items (asset, confirmed / missing / unknown) |
| `recon_exception` | — | type (seen-not-in-assets / deployed-not-seen-N-days / serial mismatch / location mismatch), asset or CI, detected_at, status, resolution |

### 9.5 Scoped tables — Phase 3

| Table | Extends | Key fields |
|---|---|---|
| Lease schedule | `ast_contract` (contract model "Lease") | lessor (the contract's vendor), schedule number (its contract number), covered assets, end date, buyout price |
| `lease_decision` | `task` | lease, decision (buyout / extend / return), due date, mismatch flag (lease end before subscription end) |
| `billing_period` | — | month, status (open / closed / locked), generated_at, CSV attachment |
| `billing_line` | — | period, account, subscription_line, days, prorated amount, fee events |
| `shipment` | — | carrier, tracking, label, status, events (from aggregator webhooks), related order / return |
| `cost_fact` | — | asset or account/site, type (purchase / lease / OEM support / field labour), amount, period |

## 10. Asset state model

- **Single source of truth:** `install_status` + `substatus` on `alm_hardware`. We add choices
  with `ChoiceSet` (`legacyChoices: false`, additive). PR 1 maps the OOB values on the instance
  first and reuses them wherever they fit.
- **Added `substatus` values** (the stages are in `docs/spec/p1-fulfilment.md`, Lifecycle stages;
  the values in `domain/vocabulary.ts` `STAGE_FIELDS`):
  - `reserved_spare_pool` — in stock, reserved for a customer's spare pool;
  - `staging`, `staged` — in the staging centre;
  - `shipped_to_site` — shipped, or at the site awaiting install;
  - `pending_in_service` — installed, not yet seen by monitoring;
  - `pending_return`, `pending_wipe`, `pending_oem_rma` (`pending_evaluation` is out-of-box);
  - `temporary_deployment`, `returned_to_customer`.
- **Enforcement:**
  - Transitions are defined in `domain/lifecycle.ts` (`checkTransition`) as an allowed-moves
    matrix, with guards such as "deployed requires site and agreement".
  - One before-update business rule on `alm_hardware` calls the matrix and rejects illegal moves
    with a clear message.
  - The app's own logic changes a stage only through `platform/assets.ts` `moveAsset` /
    `moveAndSave(asset, to, context)`.

**Indicative happy path:**

```text
On order ─► In transit (ASN) ─► In stock/available ─► In stock/staging ─► In stock/staged
   ─► In transit/pending_install ─► In use/pending_in_service ─► In use (in service)
   ─► In use/pending_return ─► In stock/pending_evaluation ─► In stock/available (refurbished)
                                                         └─► In stock/pending_oem_rma
                                                         └─► Retired/disposed|sold|returned
```

## 11. Phase 1 — Foundation and core lifecycle

Phase 1 gives every persona a working path:
- the asset manager gets the workspace, models, agreements and orders;
- the inventory tech gets receiving, put-away, staging and pick;
- the field tech gets FSM install work orders;
- the customer is served through agent-raised requests (the portal comes in P2).

### P1.1 Foundation
- Run `now-sdk init` (TypeScript). Set up ESLint, Vitest, the `@servicenow/glide` mocks harness and
  scripts (`build`, `typecheck`, `test`, `lint`, `check`).
- Docs:
  - README listing required plugins and the install steps;
  - `docs/adr/` with one ADR per major decision (base tables, single state, hybrid logic,
    visibility, OEM adapters, no AI);
  - `docs/spec/p1-*.md`.
- All P1 tables and columns, choices, roles, ACLs, before-query visibility rules, cross-scope
  privileges, application menu and modules (`Record()`).
- **Preflight check** (a scheduled script or fix script run on demand) verifies that the required
  plugins and roles exist.
- **Demo data** (installed unless `--no-demoData`):
  - 2 customers, each with sites, rooms and racks;
  - central depot, staging centre and customer-site stockrooms;
  - models for all 4 vendors (chassis, FRUs, optics);
  - site templates, agreements with quantities, subscription lines and catalog entries;
  - users for every role.

### P1.2 Models, normalisation and lifecycle data
- **Normalisation module** (`src/server/domain/normalization.ts`):
  - Inputs are the manufacturer string and the model/PID string from Discovery, SGCs or ASNs.
  - It looks up the manufacturer alias, then applies `model_match_rule` in order.
  - The result is the canonical `cmdb_model`, which gets `oem_pid` and `device_class`.
- **Unmatched values** go to a workspace list of normalisation exceptions.
- **Model lifecycle CSV import** loads rows into an import-set table; each row's milestones are
  stored in the platform's `cmdb_model_lifecycle` (ADR 0017). OEM API adapters fill the same table in P2.
- **Daily chunked job** recalculates `lifecycle_phase` and `refresh_due` on assets whose model's
  milestones changed. It is event-driven from `cmdb_model_lifecycle` updates, not a full scan.

### P1.3 Agreements, customer catalog and site templates
- Agreement maintenance (account manager), quantities, subscription lines, customer catalog entries,
  and site templates (BOMs).
- **Entitlement module** (`src/server/domain/entitlement.ts`):
  - `assessOrder(request, context)` returns `within_agreement`, `off_catalog` or `over_quota` with
    reasons.
  - Usage is counted by query when an Order is assessed (`deployedUsageQuery`,
    `inFlightLinesQuery`), against the contracted quantities in `agreement_quantity`, with no stored
    counters.

### P1.4 Ordering, approvals and sourcing
- **One catalog item**, "Request network equipment" (built as a record producer, with the
  fulfilment below in server code instead of a flow: ADR 0004). Variables:
  - account, site, order type;
  - site template **or** individual models, with choices filtered by `catalog_entry` for
    the account;
  - install mode, requested date.
- **Agent-side only in P1:** the service desk orders on the customer's behalf.
- **Fulfilment flow:** RITM → creates `order` and `order_line`s → entitlement check →
  - **within agreement** → auto-approved;
  - **off catalog** → customer admin approval;
  - **over quota** → customer admin plus account manager approval.
- **Sourcing module** (`src/server/domain/sourcing.ts` decides, `src/server/platform/sourcing.ts`
  carries it out), per line:
  1. customer's reserved spares;
  2. customer-site stockroom (for replacements);
  3. central depot stock → `alm_transfer_order`;
  4. otherwise → a purchase requisition / PO through Procurement.

  Stock is reserved by setting `substatus = reserved` and the asset reference on the line.
- **Spare pool top-up:** a chunked job compares each customer's reserved spares against
  `spare_pool_ratio` × deployed count, and raises top-up transfer orders or POs.

### P1.5 Inbound: PO receiving, ASN import, tags and put-away
- **ASN CSV import** (`ImportSet`): pre-creates assets with `install_status = In transit`, serial,
  PID → model (through normalisation) and PO line. Duplicate serials are rejected and reported.
- **Warehouse scanning app**, a React `UiPage` that is responsive and works with the camera and with
  keyboard-wedge scanners:
  - **Receive:** scan a serial, ASN number or PO number; confirm in-transit assets; or create assets
    for receipts without an ASN.
  - **Assign provider asset tag:** generated from a numbering property and printed as a barcode
    label (print CSS / PDF).
  - **Put-away:** scan the asset, then the stockroom bin/location.
  - **Pick:** scan the assets for a transfer order or order line.
  - The scanner resolves **serial, provider asset tag or customer tag**.
- **FRUs and stack members** are received as child assets (`parent` = chassis). SFPs and cables are
  received as consumable quantities where the Model's platform asset tracking strategy says so.

### P1.6 Staging
- **`staging_task`** is created per asset when the order line has an asset assigned.
  - **In-house:** the checklist is taken from the template matching customer + device class/vendor.
    Items: golden firmware, base config/template, OEM licence, controller claim, burn-in, label.
    Completion is manual in P1.
  - **Distributor pre-staged:** a short verification checklist only.
- Completing a staging task moves the asset to `staged` and advances the order line stage.

### P1.7 Delivery and installation
- **Install modes:**
  - **FSM engineer** — work order created from a template per device class.
  - **Subcontractor** — FSM work order assigned to a contractor group.
  - **Customer self-install (ZTP)** — shipped to the site; the site contact confirms the install
    (from the agent side in P1, in the portal in P2).
  - **DC remote hands** — a work order to the colocation provider's contact.
- **Change:** every on-site job gets a `change_request`.
  - Routine work (like-for-like swap, AP install) uses **standard change templates**.
  - Other work uses normal changes.
  - The FSM work order's scheduled window must fall inside the change window and the site's
    `maintenance_schedule`.
- **Shipping:** tracking numbers are entered manually until the P3 carrier aggregator.
- **Install completion** sets `In use / pending_in_service` and captures `site`, `location` (room),
  rack placement and FRU children.

### P1.8 In-service detection and subscription start
- **"Seen" sources:**
  - **Discovery and SGCs** update the CI's last-discovered timestamp. A chunked job (or a
    CI-update rule on the relevant classes only) copies it to `x_daas_ham_last_seen`.
  - **NMS push:** a Scripted REST API `POST /api/x_daas_ham/naas/device_events` takes batched
    `{identifier, event, observed_at, source}`. Auth is an integration user with a dedicated
    role; it is idempotent and rate-limited by batch size.
- **In-service rule:** `pending_in_service` plus a "seen" signal after the install completion time
  sets:
  - `In use` (in service);
  - `in_service_date`;
  - the subscription line's start date, or adds the asset to an already running line.
- **Manual override:** a `UiAction` with a mandatory reason, for sources that are not yet connected
  (not built).

### P1.9 Workspace and P1 dashboards
- **Fluent `Workspace`** with lists and forms per staff persona:
  - assets;
  - orders and order lines;
  - staging;
  - stock and transfer orders;
  - models and lifecycle, normalisation exceptions;
  - agreements and subscription lines;
  - a **per-customer provider view**, which is a list or landing page with problem filters:
    missing asset tag, serial, agreement or site, plus overdue stages.
- **P1 dashboards** (Fluent `Dashboard` + PA indicators):
  - **Operations:** spare-pool level vs ratio, staging throughput, order stage ageing,
    delivery→in-service lag.
  - **Billing integrity:** in-service assets with no subscription line, and lines with no
    delivering assets.

## 12. Phase 2 — Lifecycle processes

### P2.1 OEM EoX and coverage adapters
- **Interface:** `src/server/domain/oem/types.ts` holds the normalised DTOs; each vendor's routes
  are `OEM_ADAPTERS[vendor].lifecycle`, `.coverage` and `.rmaStatus` (optional) in
  `src/server/domain/oem/adapters.ts`.
- **Adapters:**
  - **Cisco:** EoX v5 + SN2INFO v2 + RMA status. OAuth2 client credentials through an OAuth
    profile on its `RestMessage`.
  - **Meraki:** inventory EoX fields.
  - **Fortinet:** Asset Management API v3.
  - **Mist:** JSI inventory.
  - **CSV fallback:** Aruba EoX and coverage, Check Point EoX and coverage, HPE coverage.
- **Credentials** are held in OAuth profiles on the REST messages and in password2 properties
  (README, Integrations). They are never in code.
- **Scheduling:** chunked jobs work through changed or new PIDs and serials, respecting each vendor's
  rate limits (e.g. Cisco ≤20 PIDs per EoX call, Fortinet 100/min and 1,000/h).

### P2.2 Refresh
- **Eligibility:** `refresh_due` comes from the agreement's refresh cycle (months since in-service)
  or the model reaching end of support (whichever is earlier, per agreement settings).
- **Fully automatic order creation:** a nightly job groups eligible assets per account/site → a
  refresh Order (an `order` of type `refresh`).
  - It creates a **normal change** for customer approval, scheduled inside the site's maintenance
    windows.
  - It creates a new device `order` (sourcing → staging → install).
  - It creates a swap-back `return_order` for the old device, with a deadline.

### P2.3 Break-fix (CSM case is the master record)
- **Opening the case:** the NOC opens proactive cases through the UI or monitoring integration, and
  customers can open cases too.
- **A replacement Order** (an `order` of type `device_replace`) is created from the case.
  - Source priority: site hot spare → customer reserved spare → depot → OEM advance replacement.
  - The FSM work order and standard change follow.
- **"Replace within X" SLA:** `Sla` definitions on the case, keyed by the Agreement's replacement
  service level.
- **Defective unit:** a return line is created, then evaluated → **OEM RMA**. The RMA number is
  entered manually, and status is synced for Cisco. Repaired or replacement units go back to the
  spare pool.
- **OEM coverage** per serial is shown on asset, case and replacement order.

### P2.4 Returns and decommission
- **Triggers:**
  - customer admin site decommission or device removal (portal);
  - refresh swap-back (automatic);
  - agreement end;
  - break-fix defective return.
- **How devices come back:** FSM de-install (with a change) or site-contact ship-back.
- **Depot evaluation:**
  - refurbish → `available` (wipe/reset checklist);
  - OEM RMA;
  - disposal.
- **Overdue:** `overdue_return_days` from the agreement drives escalation notifications →
  `Missing` → `fee_event` (lost). The subscription line is adjusted.

### P2.5 Disposal
- **`disposal_order` + lines**, approved by the asset manager. Customer-owned assets also need
  customer approval.
- **Wipe evidence is mandatory** before completion: reset, zeroise, credential clear, plus a
  certificate attachment.
- **Methods:**
  - broker resale (sale price);
  - OEM takeback / trade-in (credit tracking);
  - ITAD recycle (destruction certificate);
  - return to customer;
  - return to lessor. Leased assets can **only** take this method; a data policy enforces it.

### P2.6 Temporary deployments
- **A temporary Order** (an `order` of type `temporary`) covers events, pop-up sites, temporary
  sites and POC/trial kits.
- Each has an end date, and the return order is created automatically ahead of it.

### P2.7 Audits, attestation and reconciliation
- **Depot blind-count audits** run in the warehouse scanning app. Expected vs scanned produces a
  discrepancy list and resolution actions.
- **Site audits** are an FSM work order type. The engineer opens the scan page from the work order
  and scans rack contents, which are compared against the site's expected assets.
- **Customer-admin attestation** per site happens periodically in the portal, on an
  agreement-defined cadence.
- **Monitoring reconciliation** is a nightly chunked job that raises `recon_exception`s:
  - CI seen with no asset;
  - deployed and not seen for N days;
  - serial mismatch after a swap;
  - location mismatch.

  The exceptions are listed in the workspace.

### P2.8 Rack elevation view
- A React `UiPage` gives a read-only front/rear elevation per rack at a site.
  - Devices are drawn by `ru_start` and model height.
  - Colours can show status, customer, or EoX/coverage risk.
  - Clicking a device opens its record.
- Placement is edited on the asset form, with free-U validation done on the server.

### P2.9 Customer portal (CSM)
- **Customer admins:**
  - installed base by site;
  - order request (same catalog item, portal-enabled, filtered by account);
  - decommission and removal requests;
  - refresh visibility and change approvals;
  - case creation;
  - attestation.
- **Site contacts:**
  - confirm delivery and install;
  - self-install confirmation;
  - ship-back with tracking;
  - simple swaps.

### P2.10 Lifecycle risk dashboard
- EoX exposure and coverage gaps per customer and site.
- Refresh pipeline and overdue returns.
- Break-fix SLA attainment.

## 13. Phase 3 — Contracts, money and integrations

- **Leases:**
  - Lease schedules are `ast_contract` records of type lease, with covered assets.
  - A `lease_decision` task is raised N days before lease end (buyout / extend / return).
  - An alert fires when a lease ends before the subscription it serves.
- **Renewals:** customer agreement renewal, and OEM coverage expiry warnings and renewals.
- **Billing export:**
  - A monthly `billing_period` is generated by a chunked job. It prorates daily from subscription
    lines and in-service/end dates, and includes fee events.
  - Output is a CSV attachment plus a pull API,
    `GET /api/x_daas_ham/naas/billing_periods/{id}/lines`.
  - Closing the period **locks** it.
- **Shipping aggregator** (EasyPost/ShipEngine-style): labels and tracking webhooks feed `shipment`.
  It replaces manual tracking numbers.
- **OEM claim and provisioning adapters (staging automation):**
  - Meraki `inventory/claim`, rate-limited by queue;
  - HPE GreenLake device add + subscription assign;
  - FortiCloud registration + FortiZTP;
  - Mist claim;
  - Check Point Zero Touch.

  Their results tick staging checklist items automatically.
- **Margin / TCO** per customer and site: `cost_fact` (purchase, lease, OEM support, FSM labour) vs
  subscription and fee revenue.
- **Rack power budget**, using model typical power vs rack capacity.

## 14. User experience

| Persona | Surface |
|---|---|
| Asset manager, account manager, finance, NOC, admin | Fluent `Workspace` (standard layout), lists/forms per persona; dashboards |
| Inventory tech | React warehouse scanning app (phone, tablet or desktop; camera + keyboard-wedge) + workspace lists |
| Field tech | FSM mobile (work orders) + React scan page for site audits |
| Customer admin, site contact | CSM portal (P2); agent-raised on their behalf in P1 |

- React pages are linked from the workspace and navigator. Whether they can be embedded in the
  Fluent workspace is verified in PR 1.
- Notifications (`EmailNotification`) cover:
  - approvals;
  - shipment / install scheduled;
  - in-service;
  - overdue returns;
  - refresh change approval;
  - coverage expiry (P3).

## 15. Integrations

| Integration | Direction | Mechanism | Phase |
|---|---|---|---|
| Procurement (PO) | out | Base procurement tables / flow actions | P1 |
| Distributor ASN | in | CSV `ImportSet` | P1 |
| FSM | out/in | Work order templates; flow on WO completion | P1 |
| Change | out | Standard change templates / normal change via flow | P1 |
| Discovery / SGCs | in | CI last-seen → asset `last_seen` | P1 |
| NMS events | in | Scripted REST API (`RestApi`) | P1 |
| CSM cases / SLAs | in/out | Case → replacement order; `Sla` | P2 |
| Cisco / Meraki / Fortinet / Mist EoX & coverage | in | `RestMessage` + `Alias`, OEM adapter interface | P2 |
| Cisco RMA status | in | Service Order Return API | P2 |
| Billing pull API | out | Scripted REST API | P3 |
| Shipping aggregator | out/in | `RestMessage` + webhook `RestApi` | P3 |
| Meraki claim / GreenLake / FortiZTP / Mist claim / Check Point ZT | out | OEM adapter interface | P3 |

## 16. Performance and scale

- **Target:** 100k–1M `alm_hardware` rows, plus FRU children and consumables.
- **Chunked-job helper** (`src/server/domain/chunked-job.ts`, run by `src/server/platform/chunked.ts`
  with its cursors in `src/server/platform/job-cursor.ts`):
  - It works through records with a keyset cursor (`sys_id` or an indexed date), with a batch size
    set by `Property`.
  - It stops when it runs out of time and saves its position in `job_cursor`, so the next run
    resumes there.
  - ADR 0007 lists the jobs that use it (lifecycle phase, spare-pool top-up, reconciliation,
    billing among them) and how the others (refresh Orders, OEM sync) bound their work.
- **Event-driven over scans:** model lifecycle changes, CI updates and device events queue only the
  affected assets.
- **Indexes** are declared on every column we query: agreement, subscription_line, site,
  customer_tag, last_seen, refresh_due and `oem_pid`.
- **`device_event`** stores state changes only, with a retention job (property-driven, e.g. 90
  days). `last_seen` on the asset is the derived cache.
- **No GlideAggregate over all assets in synchronous code.** Contracted-quantity usage is counted
  per Agreement when an Order is assessed (P1.3), with no stored counters.
- **Scale test:** a dev-only generator script creates ~200k assets in the demo dataset. Every job
  and the key list views are timed before each phase is signed off.

## 17. Repository layout and conventions

```text
now.config.json                 # scope x_daas_ham, static content config for React pages
package.json                    # scripts: build, typecheck, test, lint, check
eslint.config.js                # lint rules, the layer rules of src/server among them
src/
  fluent/
    agreements/ orders/ staging/ warehouse/ delivery/ in-service/ fleet/ models/ oem/
    break-fix/ returns/ disposal/ assurance/ racks/ leases/ billing/ margin/ operations/
                                 # one folder per feature: its tables, logic, ACLs, forms, ATF tests
    shared/                      # roles, cross-scope privileges, platform-table columns, REST API,
                                 # menu root, visibility rules, customer page, ATF suites
    workspace/                   # workspace, list menu, dashboard
    generated/keys.ts            # committed
  server/                        # TypeScript server modules → sys_module
    domain/                      # pure rules; vocabulary.ts holds every stored choice value
    platform/                    # Glide access: operations as services, repositories, gateways,
                                 # and the lists of events and system properties
    entry/                       # one thin adapter per trigger
    test-support/                # the tests' stand-in for Glide (not built into the app)
    built-metadata.test.ts       # reads dist/app: checks what the build wrote
  client/                        # React UiPages
    warehouse/ rack/ customer/
                                 # Vitest tests are *.test.ts files beside the module they test
docs/
  adr/                           # architecture decision records
  spec/                          # per-module behavioural specs (from public docs + this plan)
  research/                      # external contracts checked against primary sources
  verify-on-instance.md          # what only an instance or a vendor login can confirm
plan.md                          # this document
README.md                        # required plugins, install, demo data, local checks
```

**Conventions**
- One folder per feature under `src/fluent`, cut into files by kind once it grows (README).
- `.now.ts` files contain no runtime logic. Logic lives in `src/server` and is imported.
- Every property is prefixed `x_daas_ham.`.
- Every cross-scope access has a matching `CrossScopePrivilege`.
- No hard-coded sys_ids. Credentials only through OAuth profiles on the REST messages and password2
  properties (README, Integrations).

## 18. Testing, quality gates and delivery

**Local gates, before every manual install (no CI by decision):** `npm run check`, which runs the
typecheck (server, client, tests), ESLint, `now-sdk build`, then Vitest, in that order: the
built-metadata tests read the build.

**Unit tests (Vitest)** cover every server module: the transition matrix, entitlement, sourcing
priority, normalisation rules, lifecycle phase calculation, in-service detection, chunked cursor,
OEM DTO mapping (from recorded fixtures), and proration (P3).

**ATF (`Test` / `TestSuite`), run with `now-sdk cicd testsuite run` on the dev instance:**
- ACLs and before-query visibility for each role, including customer admin and site contact;
- illegal state transitions are rejected;
- approval routing for within-agreement, off-catalog and over-quota requests;
- ASN import → receive;
- in-service → subscription start.

**P1 end-to-end walkthrough on demo data:**
1. A "Small branch" site order is raised for demo customer A.
2. It is auto-approved.
3. Sourcing runs: spares → depot → PO.
4. The ASN is imported and the devices are scanned in.
5. Tags are printed and the devices put away.
6. Staging checklists are completed.
7. The devices are shipped with a tracking number.
8. An FSM work order and a standard change are completed.
9. An NMS "seen" event arrives through REST.
10. The asset is in service and the subscription line start date is set.

Then repeat the checks as an inventory tech (stockroom scoping) and as a customer contact (account
scoping).

**Delivery cadence:**
- **PR 1:** foundation (§11 P1.1).
- **Then one PR per module**, each containing spec → code → unit tests → ATF. The user installs each
  PR manually on dev.
- All work is on branch `claude/amazing-hawking-46fdtv`.

| Phase | PRs (indicative) |
|---|---|
| P1 | 1 Foundation · 2 Models & lifecycle data · 3 Agreements / catalog / site templates · 4 Ordering, approvals & sourcing · 5 Inbound & warehouse app · 6 Staging · 7 Delivery & install (FSM, Change, windows) · 8 In-service & NMS API · 9 Workspace & P1 dashboards · 10 P1 hardening (scale test, ATF completion, runbook) |
| P2 | 11 OEM adapter framework + Cisco · 12 Meraki / Fortinet / Mist + CSV fallback · 13 Refresh · 14 Break-fix + OEM coverage/RMA · 15 Returns / decommission + fees · 16 Disposal · 17 Temporary deployments · 18 Audits & attestation · 19 Reconciliation · 20 Rack elevation · 21 CSM portal · 22 Lifecycle-risk dashboard |
| P3 | 23 Leases · 24 Renewals · 25 Billing periods & export API · 26 Shipping aggregator · 27 OEM claim/provisioning adapters · 28 Margin/TCO · 29 Rack power budget |
| Later | AI (Now Assist skills) — to be scoped |

## 19. Risks and known unknowns

| # | Item | Mitigation / when verified |
|---|---|---|
| R1 | Additive `ChoiceSet` on `alm_asset.substatus` / `install_status` from a scoped app | Verify in PR 1. Fallback: `Record()`-based `sys_choice` inserts. |
| R2 | Cross-scope writes to `alm_hardware`, `change_request`, `wm_order`, CSM case, Procurement tables | `CrossScopePrivilege` per table; ATF in PR 1/7. |
| R3 | React `UiPage` inside a Fluent `Workspace` | Verify in PR 1. Fallback: navigator and workspace links to standalone pages. |
| R4 | `cmdb_model` rack-height column name; base role names (inventory, procurement, CSM customer admin) | Check on the instance in PR 1 with `now-sdk dependencies --add tables`. |
| R5 | Catalog item exposure to `snc_external` contacts on the CSM portal | Spike at the start of P2.9. |
| R6 | Before-query business rule cost at 1M rows | Indexes + scale test in PR 10. |
| R7 | Plugin dependencies not declarable | README + preflight check. |
| R8 | OEM API entitlements and limits (Cisco SNTC/PSS, Meraki claim 10/5 min, Fortinet 1,000/h) | Rate-aware chunked adapters; CSV fallback. |
| R9 | Docs-only spec may miss HAM behaviour details | Written spec per module, reviewed by the user before build. |
| R10 | SDK moves fast (4.x minor releases monthly) | Pin the SDK version per phase; upgrade deliberately. |
| R11 | Change/FSM coupling may slow break-fix | Standard change templates for routine swaps; SLA measured on the case. |

## 20. Decision log

The design interview asked 76 questions. Superseded answers are marked ~~struck~~ and point to the
question that replaced them. The docs and the code cite a decision by its Q number.

| Q | Topic | Decision |
|---|---|---|
| Q1 | Purpose | Own instance(s), instead of buying a HAM subscription. |
| Q2 | Parity | Behavioural parity on the core, delivered in phases; explicit won't-build list. |
| Q3 | Reference | Public docs only; clean-room; nothing copied from `sn_hamp`. |
| Q4 | Release | Latest GA only. |
| Q5 | Data model | Extend the base `alm_*` / `cmdb_*` / `ast_contract` tables. |
| Q6 | Licences | Procurement, HRSD, PA, Discovery/SGC available. |
| Q7 | Existing data | Greenfield (reconfirmed Q69). |
| Q8 | Personas | ~~All four EUC personas~~ → NaaS personas (Q49, Q75). |
| Q9 | Org model | Several companies via `company`; no domain separation. |
| Q10 | Scale | 100k–1M assets. |
| Q11 | Delivery | Manual CLI installs. |
| Q12 | Scope | `x_daas_ham`. |
| Q13 | CI | No CI. |
| Q14 | UI | Fluent Workspace + React pages. |
| Q15 | Logic | Hybrid: flows + TS modules + chunked jobs. |
| Q16 | Tests | Unit (Vitest) + ATF. |
| Q17 | Patch | Brazil. |
| Q18 | Visibility | ~~Company + stockroom scoped~~ → Q29. |
| Q19 | Models/EoX | In-app rules + CSV (EoX source revised by Q55). |
| Q20 | Roles | Persona roles (expanded by Q75). |
| Q21 | Phasing | P1/P2/P3 accepted (contents updated for NaaS). |
| Q22 | Won't build | User needs rack/DC view, AI, provider view; the rest is excluded. |
| Q23 | Business | DaaS/MSP provider → clarified as **NaaS** (Q45). |
| Q24 | Field UX | ~~Responsive React page~~ → Q41. |
| Q25 | Customer access | ~~Full end-user self-service~~ → Q49. |
| Q26 | CSM | Licensed: `customer_account` / `customer_contact` / CSM portal. |
| Q27 | DaaS concepts | Subscriptions, agreement terms/SLAs, per-customer catalogs, billing export (unit revised by Q52). |
| Q28 | DaaS phase | Customer/agreement skeleton in P1; portal P2; billing export P3. |
| Q29 | Staff visibility | All staff see all customers; inventory techs by stockroom. |
| Q30 | Company field | Customer while assigned/reserved, provider while unassigned; scoped legal-owner and agreement fields. |
| Q31 | Stock | Central depots with per-customer reserved spare pools + customer-site stockrooms. |
| Q32 | CSM depth | Cases + agreement extending `ast_contract` + SLAs; P1 desk raises requests on the customer's behalf. |
| Q33 | Depth | Grill everything now. |
| Q34 | State | Base `install_status` / `substatus` only; TS transition matrix. |
| Q35 | Approvals | Auto within agreement; off-catalog → customer admin; over quota → + account manager. |
| Q36 | Delivery | ~~Ship / on-site / pickup~~ → Q51. |
| Q37 | Build vs buy | Build, despite ServiceNow DaaS for HAM existing. |
| Q38 | FSM | Licensed; on-site work = FSM work orders. |
| Q39 | Device prep | Checklist task, integrations later → re-scoped to staging (Q54). |
| Q40 | Inbound | PO receiving + ASN CSV import in P1. |
| Q41 | FSM vs React | FSM for field work; React app for warehouse work. |
| Q42 | Catalog | One item + data-driven filter (refined by Q50). |
| Q43 | Billing | ~~Delivery → return, daily~~ → Q52. |
| Q44 | Tags | Provider barcode tag + optional customer tag; scanner resolves both and the serial. |
| Q45 | Discovery | User clarified **NaaS (network gear)**; source question re-asked as Q53. |
| Q46 | Break-fix | Phase 2. |
| Q47 | Returns | ~~EUC triggers~~ → Q60. |
| Q48 | Refresh | Fully automatic refresh order creation (execution through Change, Q57). |
| Q49 | Customer users | Customer network/IT admins + site contacts. |
| Q50 | Orders | Site orders from template BOMs + single-device add/replace orders. |
| Q51 | Install modes | FSM engineer, customer self-install (ZTP), subcontractor, DC rack-and-stack. |
| Q52 | Billing unit | Service subscription lines; start at in-service, stop at decommission; fee events. |
| Q53 | Seen sources | Discovery (MID), controller/NMS SGCs, NMS push via REST. |
| Q54 | Staging | Mix: in-house staging centre + distributor pre-staging (verification). |
| Q55 | EoX data | Every OEM API that exists; CSV fallback. |
| Q56 | Components | Chassis + serialised FRUs as child assets; stack members individually; SFPs as consumables unless flagged. |
| Q57 | Change | Change request for all on-site work; standard templates for routine work; refresh = normal change. |
| Q58 | Break-fix master | CSM case (NOC proactive + customer). |
| Q59 | OEM coverage/RMA | Both in P2. |
| Q60 | Returns | Decommission/removal, refresh swap-back, agreement end, defective return; overdue → Missing → fee. |
| Q61 | Disposal | Disposal orders with wipe evidence; resale / takeback / ITAD / return to customer / return to lessor. |
| Q62 | Loaners | Temporary deployments (events, pop-ups, POC). |
| Q63 | Audits | Depot blind count, FSM site audits, customer attestation, monitoring reconciliation. |
| Q64 | Ownership | Provider-owned + leased + some customer-owned. |
| Q65 | Leases | Lease schedules, end-of-lease decisions, mismatch alerts (P3). |
| Q66 | Billing export | Period record + CSV + pull API + period lock (P3). |
| Q67 | Rack view | Read-only elevation P2; power budget P3. |
| Q68 | AI | Deferred until after P3. |
| Q69 | Go-live data | Truly new business; demo/seed data only. |
| Q70 | OEM phasing | EoX/coverage adapters P2; claim/provisioning adapters P3; RMA creation manual. |
| Q71 | OEM access | Cisco SNTC/PSS, Meraki non-SP, Fortinet API user, HPE Mist, HPE GreenLake. |
| Q72 | KPIs | Lifecycle risk, operations, billing integrity, margin/TCO. |
| Q73 | Carriers | Shipping aggregator (P3). |
| Q74 | Cadence | Foundation PR, then one PR per module. |
| Q75 | Roles | admin, asset_manager, inventory_tech, field_tech, account_manager, finance, noc + CSM customer admin + site_contact. |
| Q76 | Demo data | Yes, installed only with `--demo-data`. |
