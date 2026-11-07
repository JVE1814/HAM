# OEM lifecycle, coverage and RMA data (P2.1, ADR 0008)

## Adapters (`domain/oem/adapters.ts`)

| Vendor (model `OEM data source`) | Lifecycle (EoX) | Coverage by serial | RMA status |
|---|---|---|---|
| Cisco | EoX v5 by PID, at most 20 per call and 250 characters comma-joined; end of support = end of life = Last Date of Support | SN2INFO v2 summary, 50 per call; end = `covered_product_line_end_date`, else `coverage_end_date` (v1.0), else `warranty_end_date`; no start date | Service Order Return (lookup only) |
| Meraki | Dashboard inventory by model (`-HW` stripped) in each configured org | via Cisco SN2INFO | — |
| Fortinet | — (CSV) | Asset Management v3 `products/list`, one serial per call, at most 90 per run; entitlement ending last; contract number from the asset's `contracts[]` (the one with a term ending then, else the first); an API `status` other than 0 is an error | — |
| HPE Mist | JSI inventory by model (`end_of_sale_time` → end of sale, `eos_time` → end of support) | JSI inventory by serial (`warranty_start` / `warranty_end`, else `contract_start_date` / `contract_end_date`; covered when `has_support` is true or an end date is given) | — |
| HPE Aruba, Check Point | CSV | CSV | — |

- Vendor responses are read leniently. A missing field means "unknown", never a failure.
- Each HTTP failure is logged and the run continues. A FortiCloud HTTP 200 with an API `status` other
  than 0 counts as a failure.
- Response shapes come from the vendors' public documentation. **Verify them against each vendor's
  sandbox or test tenant before enabling the vendor.**

## Configuration

| Vendor | REST message | Credentials | Enable with |
|---|---|---|---|
| Cisco | `NaaS Cisco Support` | OAuth 2.0 client-credentials profile (id.cisco.com) attached to the message; SNTC/PSS entitlement | `x_daas_ham.oem.cisco.enabled` |
| Meraki | `NaaS Meraki Dashboard` | `x_daas_ham.meraki.api_key` (password2); orgs in `x_daas_ham.meraki.org_ids` | `x_daas_ham.oem.meraki.enabled` (Cisco must be enabled too for Meraki coverage) |
| Fortinet | `NaaS FortiCare` | OAuth profile (IAM API user, `client_id=assetmanagement`) | `x_daas_ham.oem.fortinet.enabled` |
| HPE Mist | `NaaS HPE Mist` | `x_daas_ham.mist.api_token` (password2); orgs in `x_daas_ham.mist.org_ids` | `x_daas_ham.oem.mist.enabled` |

## Synchronisation

- **Lifecycle (daily)**: every canonical Model with a PID and an OEM data source.
  - API milestones fill in or replace stored ones but never erase them.
  - The record's source becomes that vendor.
  - The lifecycle-change event recalculates the Model's Assets.
- **Coverage (every 4 h, time-boxed)**:
  - Covers Assets not retired and not checked for `x_daas_ham.oem.coverage_refresh_days`, oldest
    first.
  - Contracts are upserted per serial + contract number.
  - Each Asset gets its coverage end and service level (latest covering contract) and is stamped as
    checked. Records sharing a serial are all updated.
  - When a vendor call fails, only the serials it was asked about are left unchecked (the answered
    ones are stamped), and that vendor waits for the next run. When the vendor answers with an
    error of its own (FortiCloud status other than 0, an SN2INFO answer without `serial_numbers`),
    the serials keep their coverage and are asked again only after the refresh interval, so
    permanent rejections do not hold the queue.
  - A vendor's own newer lifecycle answer replaces the dates it stored before; dates from CSV or
    another source are only filled in where missing. A response without a coverage start date keeps
    the stored one.
  - Fortinet: one batch of at most 90 serials per run. FortiCloud allows 100 calls per minute and
    1000 per hour, and `products/list` takes one serial per call. Every 4 hours that is about 540
    serials a day, so a fleet above roughly 3,800 FortiGates is not fully refreshed within the
    default 7 days: raise `x_daas_ham.oem.coverage_refresh_days`, or use the CSV import for the rest.
  - A numbered API contract retires an unnumbered row stored for the same serial by an earlier sync
    (it stops covering), so it neither keeps the Asset covered nor raises expiry warnings.
- **RMA status (hourly)**: open Cisco RMAs with an RMA number.
- **CSV**: rows loaded into *OEM coverage import rows* (vendor, serial, contract, service level,
  start, end) and *Lifecycle import rows* are processed on insert.
