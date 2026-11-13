# Plan 034: Record in an ADR that the workspace is a React page, not a Fluent Workspace

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 805d5da..HEAD -- docs/adr README.md src/fluent/workspace src/client/workspace src/client/api.ts src/client/lib/sn.ts docs/verify-on-instance.md`
> If `README.md` or `docs/adr` changed since this plan was written, compare the
> "Current state" excerpts against the live files before proceeding. On a
> mismatch, treat it as a STOP condition. A change under `src/` is a mismatch
> only if a check in step 1 fails.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `805d5da`, 2026-11-12

## Why this matters

`plan.md` says the staff UI is a Fluent `Workspace` with a Fluent `Dashboard` and PA indicators
(P1.9, Q14), and lists as open risk R3 whether a React page can sit inside one. The code does
something else: since commit `641fd4c` the NaaS Asset Workspace is one React UI page, and the
Next Experience workspace is deleted. `plan.md` is kept as written and points readers at the ADRs
for what is current, but no ADR records this decision. A reader who trusts the plan looks for
Fluent workspace records that do not exist, and R3 looks open. This plan adds ADR 0019 with the
decision and its consequences, and makes the README name the workspace among the client pages and
link the ADR. One thing is not in any commit or doc: why the Next Experience workspace was dropped.
The ADR marks that sentence for the owner to fill. Do not invent a reason.

## Current state

- `docs/adr/` holds ADRs 0001-0013 and 0016-0018. Numbers 0014 and 0015 are unused. **Use 0019.**
- The repo's ADR format, from `docs/adr/0016-fleet-assets.md`, `0017-...` and `0004-...`:
  - Line 1 is `# <Title>`, a sentence that states the decision. No number in the title.
  - Then prose paragraphs that give the context and the decision together. There are no
    `## Context`, `## Decision` or `## Status` headings and no date line.
  - Then `## Consequences`, a bullet list. Some ADRs add `## Considered Options` before it.
  - Lines wrap at about 120 characters. No em dashes. Backticks around paths, tables and symbols.
  - A link to another doc is relative: `[Fleet after an upgrade](../verify-on-instance.md#fleet-after-an-upgrade)`.
- `plan.md` is not edited. Its line 7 says: "Where this plan and the code differ, the ADRs and
  `docs/spec/` are current; §5 and §18–§20 are kept as written." What it says about the workspace:
  - Line 198: "UI and reporting: `Workspace` (standard layout only), `Dashboard`, `UiPage` (React/Vite)."
  - Lines 604-617, "### P1.9 Workspace and P1 dashboards": "**Fluent `Workspace`** with lists and
    forms per staff persona" and "**P1 dashboards** (Fluent `Dashboard` + PA indicators)".
  - Line 911: "| R3 | React `UiPage` inside a Fluent `Workspace` | Verify in PR 1. Fallback:
    navigator and workspace links to standalone pages. |"
  - Line 941: "| Q14 | UI | Fluent Workspace + React pages. |"
- The code today:
  - `grep -rn 'Workspace(\|Dashboard(' src/fluent` prints nothing.
  - `src/fluent/workspace/workspace.now.ts` (whole feature folder, one file): a `UiPage` with
    endpoint `x_daas_ham_workspace.do` and an `Acl` of type `ui_page`, operation `read`, roles
    `providerStaff`. Its comment: "The provider-staff workspace: the lists and the dashboard of
    src/client/workspace, which read every table through the platform's Table and Stats APIs, so
    the tables' ACLs decide what each user sees there."
  - `src/fluent/shared/menu.now.ts:28`: the navigator module links to `${WORKSPACE_PAGE}.do`.
  - `src/client/workspace/catalog.ts`: the lists, as data (`CATEGORIES`, each list a table, an
    encoded query, columns and an audience). Lines 23-26: "Who a list or a dashboard tab is
    offered to. It decides what the sidebar and the tabs offer, never what a list shows: the ACLs
    and the before-query rules (ADR 0005) do that."
  - `src/client/workspace/dashboard.ts`: the dashboard, as data (`DASHBOARD`, tabs of widgets; a
    widget is a count, a count by one field, or a sum of a money field by currency).
    `widgetAudience` (line 270) and `tabsFor` (line 275) offer a session only the widgets whose
    table its roles read.
  - `src/client/workspace/routes.tsx`: the dashboard with `?tab=` and `/lists/$listId`.
  - `src/client/lib/sn.ts`: reads `/ui/meta/<table>` (column labels), `/table/<table>` (rows) and
    `/stats/<table>` (counts and sums) through `platformGet`. Line 62 links a row to the
    platform's own form: `` `/${table}.do?sys_id=...` ``.
  - `src/client/api.ts:19-27`: every call is a `fetch` to `/api/now` or `/api/x_daas_ham/naas`
    with the session's token in `X-UserToken`. So each read runs as the signed-in user.
  - `src/server/built-metadata.test.ts`, `describe('the NaaS Asset Workspace', ...)` (line 1047):
    the page's read ACL is provider staff's, the navigator module opens the page, each audience
    equals a role group, each widget is offered only to roles that read its table (plan 007), and
    money tables are offered to money readers only. The same file checks that every workspace list
    column is a column of its table, and `src/client/workspace/catalog.test.ts` checks the fleet
    condition in every `^NQ` clause of every list and widget on a shared table (ADR 0016).
- The history, from `git log` (read with `git show -s <sha>`):
  - `1577ac2` (2026-11-09) "Open the workspace at x/daas/naas-assets and guard its routes": the
    Next Experience workspace lived at `/x/daas/naas-assets/home`.
  - `fb1a3f1` (2026-11-11) "Build the NaaS Asset Workspace as a React page beside the Next
    Experience one": "The workspace's 53 lists in 10 categories and its 4-tab dashboard of 21
    widgets move into workspace/catalog.ts and workspace/dashboard.ts, written by a one-off
    codemod from list-menu.now.ts and dashboard.now.ts that keeps each condition's source text."
  - `641fd4c` (2026-11-11) "Retire the Next Experience workspace for the React workspace page":
    "The list menu, the dashboard, their audiences, the ux_route ACL and the parity test go, as do
    the role records only the audiences used." and "built-metadata.test.ts keeps every invariant
    it held over the built workspace and reads it from the catalog instead".
  - `d754716` (2026-11-12), the merge: "replace the NaaS Asset Workspace with a React page and
    restyle every page on one shared layer".
  - No commit message, ADR, spec or README line says why the Next Experience workspace was
    dropped. That is the one unknown.
- `docs/verify-on-instance.md`, heading "### NaaS Asset Workspace" (line 397, anchor
  `#naas-asset-workspace`), lines 410-413: "**After an upgrade** from a version with the Next
  Experience workspace (`/x/daas/naas-assets/home`): the build carries a delete for each of its
  records (`dist/app/author_elective_update`). Check that the *NaaS Asset Workspace* experience,
  its list menu with its lists, categories and audiences, the *NaaS Asset Overview* dashboard and
  the `x.daas.naas-assets.*` route ACL are gone."
- The two `README.md` places this plan changes:
  - Line 305, inside the "Layout:" code block:

    ```text
    src/client/      React UI pages (warehouse, rack elevation, customer self-service)
    ```

  - Lines 402-403, under "### Where a Fluent record goes":

    ```markdown
    - `workspace/` holds the workspace's UI page and its ACL. Its lists and its dashboard are data in
      `src/client/workspace/` (`catalog.ts`, `dashboard.ts`), each one structure over every table.
    ```

  The README links ADRs as `([ADR 0016](docs/adr/0016-fleet-assets.md))`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Lint | `npm run lint` | exit 0 (Markdown is not linted; this only shows nothing else moved) |
| Link and path check | the loops in step 4 | print nothing |
| Scope check | `git status --short` | `README.md` modified, the new ADR untracked |

No build and no test run is needed: this plan changes two Markdown files.

## Scope

**In scope** (the only files you should create or modify):
- `docs/adr/0019-workspace-is-a-react-page.md` (create)
- `README.md` (line 305 and lines 402-403 only)

**Out of scope** (do NOT touch):
- `plan.md`: its own note keeps it as written. Do not edit P1.9, R3 or Q14.
- `docs/verify-on-instance.md`, `docs/spec/`, `CONTEXT.md`, `AGENTS.md`, the other ADRs.
- Any file under `src/`.
- Filling the "Owner to fill" sentence. Only the owner knows the reason.

## Git workflow

- Branch: `advisor/034-adr-react-workspace`
- One commit with both files. Subject is an imperative sentence under 72 characters in the repo's
  style (examples: `Refuse a server module that is not a .ts file`,
  `Retire the Next Experience workspace for the React workspace page`). Suggested:
  `Record the React workspace page in ADR 0019`. The body says `plan.md` still describes a Fluent
  Workspace with PA dashboards and lists R3 as open, that no ADR recorded the change made in
  `641fd4c`, and that the reason for dropping the Next Experience workspace is left for the owner.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the facts the ADR states

```bash
ls docs/adr | grep -c '^0019'
grep -rn 'Workspace(\|Dashboard(' src/fluent | wc -l
grep -c "endpoint: \`\${WORKSPACE_PAGE}.do\`" src/fluent/workspace/workspace.now.ts
grep -c "type: 'ui_page'" src/fluent/workspace/workspace.now.ts
grep -c "'X-UserToken': window.g_ck" src/client/api.ts
grep -c '/ui/meta/\|/table/\|/stats/' src/client/lib/sn.ts
grep -c 'export function widgetAudience\|export function tabsFor' src/client/workspace/dashboard.ts
grep -c "describe('the NaaS Asset Workspace'" src/server/built-metadata.test.ts
grep -c '^### NaaS Asset Workspace' docs/verify-on-instance.md
grep -c 'React `UiPage` inside a Fluent `Workspace`' plan.md
git show -s --format=%s 641fd4c fb1a3f1
```

**Verify**: in order, the outputs are `0`, `0`, `1`, `1`, `1`, `3`, `2`, `1`, `1`, `1`, then the
two subjects `Retire the Next Experience workspace for the React workspace page` and
`Build the NaaS Asset Workspace as a React page beside the Next Experience one`. If any differs,
STOP: a fact the ADR states has changed.

### Step 2: Create the ADR

Create `docs/adr/0019-workspace-is-a-react-page.md` with exactly this content:

```markdown
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
```

**Verify**: `head -1 docs/adr/0019-workspace-is-a-react-page.md` prints
`# The workspace is a React page over the platform's Table and Stats APIs`.

**Verify**: `grep -c '—' docs/adr/0019-workspace-is-a-react-page.md` prints `0`.

**Verify**: `grep -c '^\*\*Owner to fill:\*\*' docs/adr/0019-workspace-is-a-react-page.md` prints `1`.

**Verify**: `grep -c '^## Consequences$' docs/adr/0019-workspace-is-a-react-page.md` prints `1`, and
`awk 'length > 120' docs/adr/0019-workspace-is-a-react-page.md | wc -l` prints `0`.

### Step 3: Name the workspace in the README and link the ADR

In `README.md`, make two edits.

1. Line 305. Replace

   ```text
   src/client/      React UI pages (warehouse, rack elevation, customer self-service)
   ```

   with

   ```text
   src/client/      React UI pages (workspace, warehouse, rack elevation, customer self-service)
   ```

   Keep the six spaces after `src/client/`.

2. Lines 402-403. Replace

   ```markdown
   - `workspace/` holds the workspace's UI page and its ACL. Its lists and its dashboard are data in
     `src/client/workspace/` (`catalog.ts`, `dashboard.ts`), each one structure over every table.
   ```

   with

   ```markdown
   - `workspace/` holds the workspace's UI page and its ACL. Its lists and its dashboard are data in
     `src/client/workspace/` (`catalog.ts`, `dashboard.ts`), each one structure over every table
     ([ADR 0019](docs/adr/0019-workspace-is-a-react-page.md)).
   ```

**Verify**: `grep -c 'React UI pages (workspace, warehouse, rack elevation, customer self-service)' README.md` prints `1`.

**Verify**: `grep -c 'docs/adr/0019-workspace-is-a-react-page.md' README.md` prints `1`.

**Verify**: `git diff --stat README.md` shows `1 file changed, 3 insertions(+), 2 deletions(-)`.

### Step 4: Check every path and link the two files name

```bash
for p in docs/adr/0019-workspace-is-a-react-page.md docs/verify-on-instance.md plan.md \
  docs/adr/0005-visibility-by-before-query-rules.md docs/adr/0016-fleet-assets.md \
  src/fluent/workspace/workspace.now.ts src/client/workspace/catalog.ts src/client/workspace/dashboard.ts \
  src/client/workspace/catalog.test.ts src/client/lib/sn.ts src/client/api.ts src/client/components \
  src/server/built-metadata.test.ts src/server/domain/roles.ts src/fluent/generated/keys.ts; do
  [ -e "$p" ] || echo "MISSING $p"
done
grep -q '^### NaaS Asset Workspace$' docs/verify-on-instance.md || echo "MISSING anchor"
```

**Verify**: prints nothing. If a path is missing, STOP and report it. Do not edit the ADR to fit.

### Step 5: Confirm nothing else moved, and commit

**Verify**: `git status --short` prints exactly (plus `plans/` entries if any):

```text
 M README.md
?? docs/adr/0019-workspace-is-a-react-page.md
```

**Verify**: `npm run lint` exits 0.

**Verify**: `git diff 805d5da --stat -- plan.md src docs/verify-on-instance.md` prints nothing.

Commit both files on the branch.

**Verify**: `git show --stat HEAD` lists `README.md` and `docs/adr/0019-workspace-is-a-react-page.md` only.

## Test plan

No code changes, so no tests. Step 1 checks each fact the ADR states against the code, step 4
checks every path and the anchor it names, and step 5 checks the scope.

## Done criteria

ALL must hold:

- [ ] `docs/adr/0019-workspace-is-a-react-page.md` exists and matches the content in step 2
- [ ] It holds exactly one `**Owner to fill:**` line, and no em dash
- [ ] `grep -c 'React UI pages (workspace, warehouse' README.md` prints `1`
- [ ] `grep -c 'docs/adr/0019-workspace-is-a-react-page.md' README.md` prints `1`
- [ ] The step 4 loop prints nothing
- [ ] `git diff 805d5da --stat -- plan.md src docs/verify-on-instance.md` prints nothing
- [ ] `npm run lint` exits 0
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- A file `docs/adr/0019-*.md` already exists. Report its name. Do not pick another number on your
  own.
- A check in step 1 fails. The workspace has changed since `805d5da`, and the ADR text would state
  something false.
- `README.md` line 305 or lines 402-403 do not match the excerpts in "Current state".
- You find a commit, ADR or doc that states why the Next Experience workspace was dropped. Report
  where. Do not write the reason into the ADR yourself: the owner confirms it.
- You find yourself wanting to edit `plan.md`, or to add a `## Status` or `## Context` heading the
  other ADRs do not have.

## Maintenance notes

- The owner replaces the `**Owner to fill:**` paragraph with the reason, in one or two sentences,
  and may add a `## Considered Options` section before `## Consequences` as ADR 0004 has.
- If the workspace gains server code of its own (a scripted REST route for a list or a widget),
  the "Reads as the user" bullet and its claim that ACLs alone decide must be revisited: a server
  script's GlideRecord is not checked by ACLs (ADR 0005).
- If a trend over time is wanted on the dashboard, that is a new decision (PA indicators, or a
  table the jobs write), and this ADR's first consequence changes with it.
- The ADR gives no counts of lists or widgets on purpose: they change with every list added.
- Reviewer: check each bullet of the ADR against the file it names, and that nothing in it gives a
  reason for the switch that no commit or doc records.
