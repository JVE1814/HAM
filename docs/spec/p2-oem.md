# OEM lifecycle, coverage and RMA data (P2.1, ADR 0008)

## Adapters (`domain/oem/sync-adapters.ts`, routed per vendor in `domain/oem/adapters.ts`)

| Vendor (model `OEM data source`) | Lifecycle (EoX) | Coverage by serial | RMA status |
|---|---|---|---|
| Cisco | EoX v5 by PID, batched to the vendor's limits on PIDs per call and on their comma-joined length (`eoxBatches`); end of support = end of life = Last Date of Support; each record is matched to the PID asked (`EOXInputValue`, else `EOLProductID`) ignoring case | SN2INFO v2 summary, batched (`ciscoCoverage`); end = `covered_product_line_end_date`, else `coverage_end_date` (v1.0), else `warranty_end_date`; no start date; a record without `is_covered` is logged and writes nothing, so the stored contract stands | Service Order Return (lookup only) |
| Meraki | Dashboard inventory by model (`-HW` stripped) in each configured org; the first org with a device of the model whose `eox` has a date (`endOfSaleAt` or `endOfSupportAt`); an `eox` with a null status and no dates is passed over | via Cisco SN2INFO | — |
| Fortinet | — (CSV) | Asset Management v3 `products/list`, one serial per call, capped per run (`maxKeysPerRun` in `domain/oem/adapters.ts`); entitlement ending last; contract number from the asset's `contracts[]` (the one with a term ending then, else the first); an API `status` other than 0 is an error | — |
| HPE Mist | JSI inventory by model (`end_of_sale_time` → end of sale, `eos_time` → end of support) | JSI inventory by serial (`warranty_start` / `warranty_end`, else `contract_start_date` / `contract_end_date`; covered when `has_support` is true or an end date is given) | — |
| HPE Aruba, Check Point | CSV | CSV | — |

- Vendor responses are read leniently. A missing field means "unknown", never a failure.
- Each HTTP failure is logged and the run continues. A FortiCloud HTTP 200 with an API `status` other
  than 0 counts as a failure.
- A call that gets no answer (a timeout, or a DNS, TLS or connection failure: RESTMessageV2
  status 0) is logged with the transport's reason, and its error reads *no response: <reason>*,
  never *HTTP 0*.
- Response shapes come from the vendors' public documentation. **Verify them against each vendor's
  sandbox or test tenant before enabling the vendor.**

## Configuration

| Vendor | REST message | Credentials | Enable with |
|---|---|---|---|
| Cisco | `NaaS Cisco Support` | OAuth 2.0 client-credentials profile (id.cisco.com) attached to the message; SNTC/PSS entitlement | `x_daas_ham.oem.cisco.enabled` (also serves Meraki coverage, which needs `x_daas_ham.oem.meraki.enabled` too) |
| Meraki | `NaaS Meraki Dashboard` | `x_daas_ham.meraki.api_key` (password2); orgs in `x_daas_ham.meraki.org_ids` | `x_daas_ham.oem.meraki.enabled` (Cisco must be enabled too for Meraki coverage) |
| Fortinet | `NaaS FortiCare` | OAuth profile (IAM API user, `client_id=assetmanagement`) | `x_daas_ham.oem.fortinet.enabled` |
| HPE Mist | `NaaS HPE Mist` | `x_daas_ham.mist.api_token` (password2); orgs in `x_daas_ham.mist.org_ids` | `x_daas_ham.oem.mist.enabled` |

## Synchronisation

Only NaaS Models and fleet assets are synchronised (ADR 0016): the Provider IT's equipment shares the asset table,
and none of its serials is sent to an OEM, even a unit of a NaaS Model.

- **Lifecycle (daily)**: every NaaS Model (one with an OEM PID) with an OEM data source.
  - API milestones fill in or replace stored ones but never erase them.
  - Each milestone is a row of the platform's Model lifecycle table (ADR 0017); the description of a row the
    vendor gives names that vendor's API and the bulletin. A milestone stored as given already is not saved
    again, so a row's *Updated* is when its date or provenance last changed. A row the platform refuses is logged.
  - The lifecycle-change event recalculates the Model's fleet assets (their Lifecycle phase and
    Refresh due date), once per Model whose date changed; the Provider IT's units of the Model are not stamped.
- **Coverage (every 4 h, time-boxed)**:
  - Covers fleet assets not retired and not checked for `x_daas_ham.oem.coverage_refresh_days`,
    oldest first.
  - A vendor's coverage runs only when that vendor is enabled and so is the vendor whose REST message
    serves it (`enabledRoute`): Meraki coverage needs both `x_daas_ham.oem.meraki.enabled` and
    `x_daas_ham.oem.cisco.enabled`. With Cisco enabled alone, SN2INFO is not asked about Meraki
    serials.
  - The enabled vendors take turns, one batch each, until the time budget
    (`x_daas_ham.job.budget_seconds`) is spent, so a vendor with a backlog does not hold up the
    others and the budget is not left unused while one is behind. Each enabled vendor gets at least
    one batch per run, so a run can go past the budget by up to one batch per vendor. A vendor stops
    for the run when nothing of it is stale, when a batch has errors or a refused save, or after its
    one batch when it is rate-limited (Fortinet). A vendor whose saves keep being refused for some
    Asset gets one batch per run until the cause is fixed, because that Asset stays the stalest.
  - The run holds the job lock `LOCK.oemCoverageRun` in `domain/lock-names.ts` throughout (ADR
    0013). A run that finds it held
    (the scheduled run beside *Execute now*) checks nothing, so two runs never insert one serial's
    contract twice.
  - Contracts are upserted per serial + contract number.
  - Each Asset gets its coverage end and service level (latest covering contract) and its annual
    support cost from the contracts of its serial, and is stamped as checked. Assets sharing a serial
    all get that serial's coverage; its contracts point at the last of them. A serial whose coverage
    record is refused is neither summarised onto its Assets nor stamped checked, so it is asked
    again; so is an Asset whose own save is refused. Refusals are logged.
  - A covering contract without an end date (Mist `has_support` without dates, a CSV row without an
    end date) covers open-ended: the Asset's coverage end is a far-off date
    (`OPEN_ENDED_COVERAGE_END` in `domain/coverage.ts`), so it reads as covered for
    break-fix routing (OEM advance replacement), the rack risk view and the *no coverage* list, as
    its support cost is counted.
  - When a vendor call fails, only the serials it was asked about are left unchecked (the answered
    ones are stamped), and that vendor waits for the next run. When the vendor answers with an
    error of its own (FortiCloud status other than 0, an SN2INFO answer without `serial_numbers`),
    the serials keep their coverage and are asked again only after the refresh interval, so
    permanent rejections do not hold the queue.
  - Lifecycle answers are merged: a new date replaces the stored one, and dates a vendor does not
    give (for example an end of life from the CSV import) are kept; the CSV import merges the same way. A
    coverage response without a start date keeps the stored one.
  - Models are matched to a lifecycle answer by PID, ignoring case and surrounding spaces (each PID
    is asked once; Models sharing it each get the dates). An answer for no Model, and a lifecycle
    save the platform refuses, are logged. Each job logs its first errors per run (`ERRORS_LOGGED`
    in `platform/oem-sync.ts`) and one line
    counting the rest.
  - Fortinet: one batch per run, capped at `maxKeysPerRun`. FortiCloud allows 100 calls per minute and
    1000 per hour, and `products/list` takes one serial per call. The cap times the coverage job's
    runs a day (its interval is in `oem/logic.now.ts`) is what a day refreshes. A fleet of more
    FortiGates than that many days of `x_daas_ham.oem.coverage_refresh_days` refresh is not fully
    refreshed in time: raise the property, or use the CSV import for the rest.
- **RMA status (hourly)**: open Cisco RMAs with an RMA number, a capped number per run
  (`RMAS_PER_SYNC` in `platform/oem-rma.ts`), least recently
  checked first. Every RMA asked is stamped *Last checked*, answered or not, so all of them take
  turns. *Last checked* is when the RMA was last asked, including when Cisco did not answer or the
  call failed (failures are logged). An RMA whose save is refused is logged (it keeps its place at
  the front).
- **CSV**: rows loaded into *OEM coverage import rows* (vendor, serial, contract, service level,
  start, end) and *Lifecycle import rows* are processed on insert. A coverage row applies to the fleet
  asset with its serial; one whose serial no fleet asset carries (none, or only the Provider IT's) is
  marked error *no fleet asset with serial ...*. A row whose coverage, or one of whose lifecycle
  milestones, the platform refuses is marked error with the reason, to load again once the cause is fixed.
