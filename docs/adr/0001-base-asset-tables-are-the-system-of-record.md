# Base asset tables are the system of record

Assets live in the platform's `alm_hardware` / `alm_asset` tables (with `cmdb_model`, `alm_stockroom`,
`cmn_location`, `ast_contract`), and we add scoped `x_daas_ham_*` columns to them with `Table({ augments })`.
Scoped tables exist only for concepts the platform lacks (Agreements, Orders, Staging tasks, ...).
A parallel asset table would have broken the asset↔CI sync, Procurement receiving, CSM/FSM references
and out-of-box reporting, and would consume custom-table entitlement.

## Consequences

- Every global table we read or write needs a `CrossScopePrivilege`.
- Columns on global tables carry the `x_daas_ham_` prefix.
