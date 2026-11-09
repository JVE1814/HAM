# Model lifecycle milestones live in the platform's table

A Model's manufacturer support milestones (end of sale, end of support, end of extended support, end of life) are
kept in the platform's Model lifecycle table, `cmdb_model_lifecycle` with its child `cmdb_hardware_model_lifecycle`
(Model Management, `com.snc.model`: on a Brazil instance without Hardware Asset Management Professional). The app's own table
`x_daas_ham_model_lifecycle`, one record per Model with four date columns, is gone: the platform has the concept
(ADR 0001), the Provider's IT can keep its milestones in the same place, and where ServiceNow's content service is
licensed its rows are read without any import.

- **One row per Model and milestone**: lifecycle type *Publisher* (the manufacturer's dates, not an organisation's own
  plan), the milestone as the lifecycle phase, its date as the phase start date, active.
- **The app writes** hardware lifecycle rows of source *Internal*. Where a date comes from (manual, CSV import, a
  vendor's API, and the bulletin it names) is one line in the row's description; when it was last changed is the
  row's own *Updated*.
- **The app reads** every active Publisher row of the Model, of either class and any source, so a milestone IT keeps
  by hand or the content service supplies (source *ServiceNow*) counts. Where two rows give the same milestone, the
  *Internal* one wins.
- `platform/model-lifecycle` is the one module that reads and writes the table and knows its phase names. The rest of
  the app works with `LifecycleDates`; an Asset's *Lifecycle phase* stays a derived cache with its own values.

## Consequences

- **Shared table** (ADR 0016): the table holds the milestones of the Provider IT's Models too. The app's rule on it
  acts for NaaS Models only (the Model has an OEM PID) and only when what a Model's milestones are read from changed
  (start date, active, phase, type, Model, or a new row), testing that first; the daily roll and the navigator and
  workspace lists keep to NaaS Models the same way. The app adds no ACL, form or list layout to the table.
- **No delete from the app's scope**: the platform lets this scope read, create and update rows, not delete them. A
  write therefore never removes a milestone: one a source does not give keeps what is stored, for the CSV import as
  for the vendor APIs (the import used to blank it). A milestone stored by mistake is deactivated or deleted by hand.
- **The platform's rules apply to the app's rows**: an insert without a start date is refused; so is a second active
  row for one Model, lifecycle type, phase and source, which is why a write updates the Internal row it finds, of
  either class, and only otherwise creates one; a hardware lifecycle row takes a hardware Model only, so a NaaS Model
  of another class has its milestones refused. A refused row is logged, or marks its import row error, with the
  platform's reason; the other milestones of the same write are saved.
- **One recomputation per write**: a write can save up to four rows, and the rule would queue the Model's
  recomputation for each. The write marks its Model while it saves (the per-transaction marks of ADR 0005's reads),
  the rule leaves a marked Model's saves alone, and the write queues the pass once, when a date changed. A milestone
  stored as given is not saved again.
- **Roles**: the platform's ACLs let every internal user read the table, an inventory tech included, and only
  `model_manager` create or change a row. The asset manager role contains `model_manager`.
- **Upgrades**: for an instance that had the earlier version, the build carries deletes for the ACLs, form, list,
  labels and choices of `x_daas_ham_model_lifecycle` and none for the table itself, which is left in place with its
  rows (to confirm on the first upgrade: README, *Verify on the first install*). The app no longer reads them and
  does not migrate them: an administrator loads them again through the lifecycle import or enters them by hand.
