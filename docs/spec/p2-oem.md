# OEM lifecycle, coverage and RMA data (P2.1, ADR 0008)

## Adapters (`domain/oem/adapters.ts`)

| Vendor (model `OEM data source`) | Lifecycle (EoX) | Coverage by serial | RMA status |
|---|---|---|---|
| Cisco | EoX v5 by PID, 20 per call; end of support = end of life = Last Date of Support | SN2INFO v2, 50 per call | Service Order Return (lookup only) |
| Meraki | Dashboard inventory by model (`-HW` stripped) in each configured org | via Cisco SN2INFO | — |
| Fortinet | — (CSV) | Asset Management v3, entitlement ending last | — |
| HPE Mist | JSI inventory by model (`eos_time` → end of sale, `eol_time` → end of life) | JSI inventory by serial (warranty / contract dates) | — |
| HPE Aruba, Check Point | CSV | CSV | — |

- Vendor responses are read leniently. A missing field means "unknown", never a failure.
- Each HTTP failure is logged and the run continues.
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
    checked.
- **RMA status (hourly)**: open Cisco RMAs with an RMA number.
- **CSV**: rows loaded into *OEM coverage import rows* (vendor, serial, contract, service level,
  start, end) and *Lifecycle import rows* are processed on insert.
