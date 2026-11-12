# The workspace is a React page over the platform's Table and Stats APIs

The plan called for a Fluent `Workspace` with lists and forms per staff persona, and dashboards built as a Fluent
`Dashboard` with PA indicators (`plan.md` P1.9, Q14). The app was first built that way: a Next Experience workspace at
`/x/daas/naas-assets/home`, with its list menu and its dashboard as Fluent records. It is gone. The NaaS Asset
Workspace is one React UI page, `x_daas_ham_workspace.do` (`src/fluent/workspace/workspace.now.ts`,
`src/client/workspace/`), built on the layer the warehouse, rack and customer pages share (`src/client/lib`,
`src/client/components`). The page was built beside the Next Experience workspace, held to its built records by a
parity test, and the old workspace was then removed.

**Owner to fill:** why the Next Experience workspace was dropped. No commit, spec or other ADR records the reason.

What the page is:

- **Lists and dashboard as data.** `workspace/catalog.ts` holds every list (table, encoded query, columns, audience) in
  its categories, and `workspace/dashboard.ts` every dashboard tab and widget (a count, a count by one field, or a sum
  of a money field by its currency). Each is one structure over every table, not a record per list or widget. The
  conditions were carried over from the Fluent list menu and dashboard with their source text kept.
- **Reads as the user.** The page reads column labels (`/api/now/ui/meta`), rows (the Table API) and counts and sums
  (the Stats API) with the session's token (`src/client/lib/sn.ts`, `src/client/api.ts`). Each read runs as the
  signed-in user, so the tables' ACLs and before-query rules decide what a list or a widget shows (ADR 0005). The page
  has no server code of its own.
- **Audiences offer, they do not grant.** A list, a tab and a widget each have an audience, a role group of
  `domain/roles`. It decides what the sidebar and the tabs offer a user, never what they may read.
- **Forms stay the platform's.** A row links to the record's own form (`<table>.do`).
- **Opened from the navigator.** The page has a `ui_page` read ACL for provider staff, and the navigator's *NaaS Asset
  Workspace* module links to it.

This settles `plan.md` R3 (a React `UiPage` inside a Fluent `Workspace`): there is no Fluent Workspace for a page to
sit in, so the question no longer arises. What is in place has the shape of R3's fallback, a navigator link to a
standalone page. Whether embedding was ever tried is not recorded.

## Consequences

- No Fluent `Workspace`, `Dashboard` or PA indicator is in the app. A dashboard figure is counted when the page is
  opened, from the rows the user may read; nothing is collected over time, so the dashboard shows no trend.
- A new list or widget is an entry in `catalog.ts` or `dashboard.ts`, with no Fluent record and no key in
  `generated/keys.ts`. `src/fluent/workspace/` holds the page and its ACL only.
- What the built workspace records guaranteed is held by tests over the catalog instead. `built-metadata.test.ts`
  checks that the page's read ACL is provider staff's and the navigator module opens it, that each audience equals its
  role group, that a widget is offered only to roles that read its table and money tables only to money readers, and
  that every list column is a column of its table. `workspace/catalog.test.ts` checks that every list and widget on a
  table shared with the Provider's IT carries the fleet condition in each `^NQ` clause, for any search and sort a user
  picks (ADR 0016).
- A widget offered to a role that cannot read its table would show a refusal, not data: the ACL still decides. The
  audience check above exists so that no role is offered such a widget.
- An upgrade from a version with the Next Experience workspace carries a delete for each of its records. What to check
  on the instance afterwards is in
  [NaaS Asset Workspace](../verify-on-instance.md#naas-asset-workspace), with what each role sees on the page.
- `plan.md` is kept as written (its own note says so): P1.9, Q14 and R3 still describe the Fluent Workspace. This ADR
  is what is current.
