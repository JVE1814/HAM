# Plan 022: Draft the scale test: a design doc and a generator prototype, run on no instance

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **This plan writes to no instance.** Everything it asks for runs on your own
> machine. Do not deploy, do not paste a script into an instance, do not call an
> instance's API. See "STOP conditions".
>
> **Drift check (run first)**: `git diff --stat 1864b17..HEAD -- tools docs/research docs/verify-on-instance.md src/server/entry/demo-seed.ts src/server/platform/assets.ts now.config.json eslint.config.js package.json`
> `eslint.config.js` is expected to have changed (plan 001). Other plans may
> have edited other sections of `docs/verify-on-instance.md`. For the rest,
> compare the "Current state" excerpts against the live code. A mismatch in an
> excerpt itself is a STOP condition.

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: LOW for this plan (local files only). The run it prepares is HIGH (bulk writes to an instance) and is not part of this plan.
- **Depends on**: `plans/001-lint-tracked-sources.md` (so `npm run lint` is a usable gate, and covers the new `tools/` folder)
- **Category**: direction
- **Planned at**: commit `1864b17`, 2026-11-12

## Why this matters

The app's stated goal is to cope with 100k to 1M hardware assets (`plan.md` line 86). `plan.md`
promises a scale test: a dev-only generator that creates about 200k assets, with every job and the
key list views timed before each phase is signed off. Risk R6 (the cost of the before-query
visibility rules at 1M rows) is to be settled by that test. No generator exists, and the "Scale"
entry of `docs/verify-on-instance.md` is one manual paragraph. So nobody knows whether the chunked
jobs and the visibility rules hold at volume.

This plan is a design spike. It does not run the scale test. It produces what the owner needs to
decide and approve one: a design doc with explicit open questions, and a generator prototype that is
proven on in-memory tables and is never part of the app package. Writing 200k rows to an instance is
hard to reverse, so the plan stops before any instance is touched.

## Current state

### What exists

- `plan.md:815-816`:

  ```md
  - **Scale test:** a dev-only generator script creates ~200k assets in the demo dataset. Every job
    and the key list views are timed before each phase is signed off.
  ```

- `plan.md:914`: `| R6 | Before-query business rule cost at 1M rows | Indexes + scale test in PR 10. |`
- `docs/verify-on-instance.md:194-198`:

  ```md
  ### Scale

  Before-query rule performance and the chunked jobs at your data volumes (indexes are declared on the
  scoped columns). The *Job cursor* list (*Administration > Background jobs*; *Background job
  cursors* in the workspace) shows how each scheduled pass ended: ...
  ```

- `tools/`: an empty, untracked folder at the repo root. Nothing in the build reads it.
  `now.config.json` takes server modules from `./src/server/tsconfig.json`, the Fluent metadata comes
  from `src/fluent`, the pages from `src/client`. `vitest.config.ts` includes only `src/server` and
  `src/client` tests. `tsconfig.test.json` includes only `src/**` and `vitest.config.ts`.
- `docs/research/` holds one file, `external-contracts.md`. The design doc goes beside it.

### The shapes the generator copies

`src/server/entry/demo-seed.ts` loads the demo data. The generator follows its shapes.

```ts
// src/server/entry/demo-seed.ts:23-35 (find a row by its key, insert it when there is none)
function ensure(table: string, key: Fields, fields: Fields = {}): string {
    const gr = new GlideRecord(table)
    for (const [field, value] of Object.entries(key)) gr.addQuery(field, value)
    gr.setLimit(1)
    gr.query()
    if (gr.next()) return gr.getUniqueValue()
    gr.initialize()
    for (const [field, value] of Object.entries({ ...key, ...fields })) gr.setValue(field, value)
    const id = gr.insert()
    if (id) return id
    log.warn(`Demo ${table} ${JSON.stringify(key)} not created: ${refusal(gr)}`)
    return ''
}
// :51
const DEMO_PROVIDER = 'Demo NaaS Provider'
// :112, :116-117
const customer = (name: string, number: string) => ensure('customer_account', { name }, { customer: true, number })
const site = (name: string, company: string, city: string) =>
    ensure('cmn_location', { name }, { company, city, [SITE_FIELD]: true })
// :305-309 (an in-service asset)
stock(c9300, 2, 'DEMOLIVE', 'in_service', {
    company: acme, x_daas_ham_agreement: acmeAgreement, x_daas_ham_site: acmeHq, location: acmeMdf, x_daas_ham_rack: acmeRack,
    x_daas_ham_rack_face: 'front', x_daas_ham_subscription_line: acmeHqPackage, x_daas_ham_in_service_date: '2026-02-01 09:00:00',
    x_daas_ham_install_completed: '2026-02-01 08:00:00', x_daas_ham_last_seen: '2026-11-06 23:00:00', x_daas_ham_seen_source: 'nms',
})
// :354-359 (its Service interval)
ensure('x_daas_ham_service_interval', { asset: leased.getUniqueValue() }, {
    subscription_line: acmeHqPackage,
    customer: acme,
    site: acmeHq,
    start_date: '2026-02-01',
})
```

- `demoRefusal` (`demo-seed.ts:59-67`) refuses an instance whose Provider company
  (`x_daas_ham.provider_company`) is not the demo's. Its comment says
  `glide.installation.production` cannot tell a production instance, as a personal developer
  instance reports true. The generator uses the same test, and requires the demo data to be loaded.
- `SITE_FIELD` is `'x_daas_ham_is_site'` (`src/server/domain/fleet.ts:153`). `OEM_PID_FIELD` is
  `'x_daas_ham_oem_pid'` (`fleet.ts:121`). The demo Models have the PIDs `C9300-48P-E`, `MR46-HW`
  and `FG-60F` (`demo-seed.ts:164-172`).
- `src/server/platform/assets.ts:96`: `export function newAsset(modelId: string, stage: Stage): GlideRecord`.
  Its comment ends "Every Asset the app creates is made here." The generator calls it through
  `require`, by the module's installed path, as the ATF scripts load modules
  (`src/fluent/orders/tests.now.ts:365`:
  `require('x_daas_ham/naas-ham/0.1.0/src/server/entry/orders.ts')`).

### Conventions that apply

- ESLint (`npm run lint`, `eslint .`) lints `tools/` too. A script for an instance uses globals
  ESLint does not know. Name them in a `/* global ... */` comment at the top of the file, as the
  files in this plan do. The config forbids `require()` calls
  (`@typescript-eslint/no-require-imports`); the generator has one, with a disable comment that
  says why.
- Scripts that run on the instance outside the app's modules are written in ES5 style (`var`,
  `function`), like the ATF step scripts in `src/fluent/*/tests.now.ts`.
- No secret goes into any file. The scripts and the doc name no instance, user or password.
- Prose: short declarative sentences, sentence-case headings, no em dashes.

### Design decisions already made (do not reopen)

- **Where the generator lives**: `tools/scale/`. It is a script for *Scripts - Background* on a dev
  instance. It is not a server module, not a Fluent record, and not demo data, so it can never be
  installed with the app.
- **Fail closed**: each script writes nothing unless `PARAMS.confirm` equals the instance's
  `instance_name` property. The generator also needs the demo Provider. The defaults ship with
  `confirm: ''`.
- **Idempotent and resumable**: every row is found by its key before it is inserted. A run stops at
  a cap or time budget and the next run goes on. A finished run creates nothing.
- **Named for removal**: every generated row has a name that starts with `Scale` or `SCALE`.
- **Proof at planning time**: the three files in steps 2 to 4 were run as given. The dry run printed
  the line in step 4, ESLint passed on them, and a build with them in place left no trace of them in
  `dist/`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Dry run of the prototype | `node tools/scale/dry-run.mjs` | exit 0, one line starting `dry run ok:` |
| Syntax of a script | `node --check tools/scale/generate-fleet.js` | exit 0, no output |
| Lint the new folder | `npx eslint tools` | exit 0 |
| Lint | `npm run lint` | exit 0 (needs plan 001) |
| Build | `npm run build` | exit 0, ends with `Build completed successfully` |
| Full gate | `npm run check` | exit 0, all tests pass |

## Scope

**In scope** (the only files you should create or modify):

- `tools/scale/generate-fleet.js` (create)
- `tools/scale/cleanup-fleet.js` (create)
- `tools/scale/dry-run.mjs` (create)
- `docs/research/scale-test.md` (create)
- `docs/verify-on-instance.md` (one paragraph added to the "Scale" subsection only)

**Out of scope** (do NOT touch, even though they look related):

- Any instance. No deploy, no script pasted, no API call. Not even a read.
- `src/**`: the generator is no part of the app. Do not add a scheduled job, a property, a server
  module or a Fluent record for it. Do not change `demo-seed.ts`.
- `plan.md`: it still says the generator is "in the demo dataset". The design doc records the
  difference; the owner decides whether `plan.md` changes.
- `README.md`, `now.config.json`, `eslint.config.js`, `vitest.config.ts`, `package.json`: no new
  script, dependency or config entry is needed.
- Agreed thresholds. The doc proposes numbers and marks them as proposals. Do not write them into
  `docs/verify-on-instance.md` as checks.

## Git workflow

- Branch: `advisor/022-scale-spike`
- Two commits, subjects in the repo's style (imperative sentences under 72 characters), for example:
  `Add a scale generator prototype that runs on no instance yet` (the three files under `tools/`)
  and `Draft the scale test design with its open questions` (the two docs).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the facts the prototype and the doc rely on

```sh
grep -n "const DEMO_PROVIDER = " src/server/entry/demo-seed.ts
grep -c "'C9300-48P-E'\|'MR46-HW'\|'FG-60F'" src/server/entry/demo-seed.ts
grep -n "export function newAsset" src/server/platform/assets.ts
grep -n "export const SITE_FIELD\|export const OEM_PID_FIELD" src/server/domain/fleet.ts
grep -n '"version"' package.json
grep -n "jobBatchSize\|jobBudgetSeconds" src/server/domain/properties.ts
grep -n "CANDIDATES_PER_RUN = " src/server/platform/refresh.ts
grep -c "table: '" src/fluent/shared/visibility.now.ts
ls tools docs/research
```

**Verify**: in order: `const DEMO_PROVIDER = 'Demo NaaS Provider'`; `3`; one line with
`newAsset(modelId: string, stage: Stage)`; `OEM_PID_FIELD = 'x_daas_ham_oem_pid'` and
`SITE_FIELD = 'x_daas_ham_is_site'`; `"version": "0.1.0"`; defaults `500` and `120`;
`CANDIDATES_PER_RUN = 2000`; a count of 21 or more; `tools` empty or holding nothing but what this
plan creates, and `docs/research` holding `external-contracts.md`.

If the version is not `0.1.0`, use the version you see in `assetsModule` in step 2 and in the doc.
Any other difference is a STOP condition.

### Step 2: Create the generator

Create `tools/scale/generate-fleet.js` with exactly this content:

```js
/* global GlideRecord, GlideDateTime, gs, require, SCALE_PARAMS */
/*
 * NAAS_SCALE_GENERATOR: a prototype, for a disposable dev instance only (docs/research/scale-test.md).
 * Paste into Scripts - Background, scope x_daas_ham, after the demo data is loaded. It is no part of the app package.
 * It creates Customers, Sites, Agreements, site-package Subscription lines and in-service fleet assets with their
 * Service intervals, each under a name that starts with Scale or SCALE. A run stops at its cap or time budget;
 * run it again and it goes on where it stopped. A finished run creates nothing more.
 */
(function () {
    var PARAMS =
        typeof SCALE_PARAMS === 'undefined'
            ? {
                  // The instance_name property of the instance to write to. Empty: the script writes nothing.
                  confirm: '',
                  customers: 2,
                  sitesPerCustomer: 2,
                  assetsPerSite: 5,
                  maxAssetsPerRun: 2000,
                  budgetSeconds: 120,
                  // The installed path of platform/assets.ts: it names the version in package.json.
                  assetsModule: 'x_daas_ham/naas-ham/0.1.0/src/server/platform/assets.ts',
              }
            : SCALE_PARAMS;

    var DEMO_PROVIDER = 'Demo NaaS Provider';
    var MODEL_PIDS = ['C9300-48P-E', 'MR46-HW', 'FG-60F'];
    var started = new Date().getTime();
    var created = {};
    var refused = 0;
    var assetsThisRun = 0;

    function say(message) {
        gs.info('Scale generator: ' + message);
    }

    function pad(number, width) {
        var text = String(number);
        while (text.length < width) text = '0' + text;
        return text;
    }

    function count(table) {
        created[table] = (created[table] || 0) + 1;
    }

    /** Why this instance must not be written to, or an empty string. */
    function refusal() {
        var instance = gs.getProperty('instance_name', '');
        if (!PARAMS.confirm) return 'PARAMS.confirm is empty: set it to the name of the dev instance to write to';
        if (PARAMS.confirm !== instance) return 'PARAMS.confirm is ' + PARAMS.confirm + ' but this instance is ' + instance;
        var provider = new GlideRecord('core_company');
        if (!provider.get(gs.getProperty('x_daas_ham.provider_company', '')) || provider.getValue('name') !== DEMO_PROVIDER) {
            return 'the Provider of this instance is not ' + DEMO_PROVIDER + ': load the demo data on a dev instance first';
        }
        return '';
    }

    /** The sys_id of the row of `table` with the `key` values, inserted with `fields` too when there is none. */
    function ensure(table, key, fields) {
        var record = new GlideRecord(table);
        var name;
        for (name in key) record.addQuery(name, key[name]);
        record.setLimit(1);
        record.query();
        if (record.next()) return record.getUniqueValue();
        record.initialize();
        for (name in key) record.setValue(name, key[name]);
        for (name in fields) record.setValue(name, fields[name]);
        var id = record.insert();
        if (id) {
            count(table);
            return id;
        }
        refused++;
        say(table + ' ' + JSON.stringify(key) + ' not created: ' + record.getLastErrorMessage());
        return '';
    }

    function modelIds() {
        var ids = [];
        for (var i = 0; i < MODEL_PIDS.length; i++) {
            var model = new GlideRecord('cmdb_hardware_product_model');
            if (!model.get('x_daas_ham_oem_pid', MODEL_PIDS[i])) return [];
            ids.push(model.getUniqueValue());
        }
        return ids;
    }

    function spent() {
        return assetsThisRun >= PARAMS.maxAssetsPerRun || new Date().getTime() - started >= PARAMS.budgetSeconds * 1000;
    }

    function assetsOf(sitePrefix) {
        var asset = new GlideRecord('alm_hardware');
        asset.addQuery('serial_number', 'STARTSWITH', sitePrefix);
        asset.query();
        return asset.getRowCount();
    }

    /** False when the run's cap or budget was spent before the Site had all its assets. */
    function fillSite(assets, models, at, customer, agreement, site, line) {
        var sitePrefix = 'SCALE' + pad(at.customer, 4) + pad(at.site, 3);
        if (assetsOf(sitePrefix) >= PARAMS.assetsPerSite) return true;
        var now = new GlideDateTime().getValue();
        for (var unit = 1; unit <= PARAMS.assetsPerSite; unit++) {
            var serial = sitePrefix + pad(unit, 4);
            var found = new GlideRecord('alm_hardware');
            var id = found.get('serial_number', serial) ? found.getUniqueValue() : '';
            if (!id) {
                if (spent()) return false;
                var asset = assets.newAsset(models[unit % models.length], 'in_service');
                asset.setValue('serial_number', serial);
                asset.setValue('asset_tag', 'SCL' + serial.slice(5));
                asset.setValue('x_daas_ham_staging_source', 'in_house');
                asset.setValue('company', customer);
                asset.setValue('x_daas_ham_agreement', agreement);
                asset.setValue('x_daas_ham_site', site);
                asset.setValue('location', site);
                asset.setValue('x_daas_ham_subscription_line', line);
                asset.setValue('x_daas_ham_install_completed', '2026-02-01 08:00:00');
                asset.setValue('x_daas_ham_in_service_date', '2026-02-01 09:00:00');
                asset.setValue('x_daas_ham_last_seen', now);
                asset.setValue('x_daas_ham_seen_source', 'nms');
                id = asset.insert();
                assetsThisRun++;
                if (!id) {
                    refused++;
                    say('asset ' + serial + ' not created: ' + asset.getLastErrorMessage());
                    continue;
                }
                count('alm_hardware');
            }
            ensure('x_daas_ham_service_interval', { asset: id }, { subscription_line: line, customer: customer, site: site, start_date: '2026-02-01' });
        }
        return true;
    }

    function run() {
        var why = refusal();
        if (why) return say('nothing written: ' + why);
        var models = modelIds();
        if (!models.length) return say('nothing written: a demo Model (' + MODEL_PIDS.join(', ') + ') is missing: load the demo data first');
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- the instance loads a server module by its installed path
        var assets = require(PARAMS.assetsModule);
        var complete = true;
        for (var c = 1; c <= PARAMS.customers && complete; c++) {
            var name = 'Scale Customer ' + pad(c, 4);
            var customer = ensure('customer_account', { name: name }, { customer: true, number: 'ACCT-SCALE-' + pad(c, 4) });
            var agreement = ensure('x_daas_ham_agreement', { customer: customer }, {
                short_description: name + ' network',
                state: 'active',
                account_manager: gs.getUserID(),
                currency: 'EUR',
                starts: '2026-01-01',
                ends: '2030-12-31',
                replacement_tier: 'same_day',
                refresh_cycle_months: 60,
                refresh_basis: 'earliest',
                spare_pool_ratio: 0,
                overdue_return_days: 30,
                lost_asset_fee: 1500,
                late_return_fee: 150,
                damage_fee: 400,
                attestation_interval_months: 12,
            });
            for (var s = 1; s <= PARAMS.sitesPerCustomer && complete; s++) {
                var siteName = 'Scale Site ' + pad(c, 4) + '-' + pad(s, 3);
                var site = ensure('cmn_location', { name: siteName }, { company: customer, city: 'Scale City', x_daas_ham_is_site: true });
                var line = ensure('x_daas_ham_subscription_line', { description: siteName + ' package' }, {
                    agreement: agreement,
                    customer: customer,
                    line_type: 'site_package',
                    site: site,
                    monthly_rate: 100,
                    status: 'active',
                    start_date: '2026-02-01',
                });
                if (!customer || !agreement || !site || !line) continue;
                complete = fillSite(assets, models, { customer: c, site: s }, customer, agreement, site, line);
            }
        }
        var seconds = Math.round((new Date().getTime() - started) / 1000);
        var end = complete ? 'complete' : 'stopped at its cap or time budget: run it again to go on';
        say('created ' + JSON.stringify(created) + ', ' + refused + ' refused, in ' + seconds + ' s; ' + end);
    }

    run();
})();
```

**Verify**: `node --check tools/scale/generate-fleet.js; echo "exit $?"` → `exit 0`. And
`grep -c "confirm: ''" tools/scale/generate-fleet.js` → `1` (the default writes nothing).

### Step 3: Create the cleanup

Create `tools/scale/cleanup-fleet.js` with exactly this content:

```js
/* global GlideRecord, gs, SCALE_PARAMS */
/*
 * NAAS_SCALE_CLEANUP: removes what tools/scale/generate-fleet.js created (docs/research/scale-test.md).
 * Paste into Scripts - Background, scope x_daas_ham. It deletes only rows named Scale or SCALE, a capped number a
 * run; run it again until it says complete. It does not remove what the jobs derived from those rows (billing
 * lines, Cost facts, exceptions): the design doc says how those are handled.
 */
(function () {
    var PARAMS =
        typeof SCALE_PARAMS === 'undefined'
            ? {
                  // The instance_name property of the instance to delete from. Empty: the script deletes nothing.
                  confirm: '',
                  maxRowsPerRun: 5000,
                  budgetSeconds: 120,
              }
            : SCALE_PARAMS;

    // Children before what they refer to. Each entry: table, field, the prefix its value starts with.
    var STEPS = [
        ['x_daas_ham_service_interval', 'asset.serial_number', 'SCALE'],
        ['alm_hardware', 'serial_number', 'SCALE'],
        ['x_daas_ham_subscription_line', 'description', 'Scale Site '],
        ['x_daas_ham_agreement', 'customer.name', 'Scale Customer '],
        ['cmn_location', 'name', 'Scale Site '],
        ['customer_account', 'name', 'Scale Customer '],
    ];
    var started = new Date().getTime();
    var deleted = {};
    var total = 0;
    var refused = 0;

    function say(message) {
        gs.info('Scale cleanup: ' + message);
    }

    function spent() {
        return total >= PARAMS.maxRowsPerRun || new Date().getTime() - started >= PARAMS.budgetSeconds * 1000;
    }

    /** False when rows of the step are left: the run's cap or budget was spent, or a delete was refused. */
    function clear(step) {
        var record = new GlideRecord(step[0]);
        record.addQuery(step[1], 'STARTSWITH', step[2]);
        record.query();
        while (record.next()) {
            if (spent()) return false;
            if (!record.deleteRecord()) {
                refused++;
                say(step[0] + ' ' + record.getUniqueValue() + ' not deleted: ' + record.getLastErrorMessage());
                return false;
            }
            deleted[step[0]] = (deleted[step[0]] || 0) + 1;
            total++;
        }
        return true;
    }

    function run() {
        var instance = gs.getProperty('instance_name', '');
        if (!PARAMS.confirm) return say('nothing deleted: PARAMS.confirm is empty: set it to the name of the dev instance');
        if (PARAMS.confirm !== instance) return say('nothing deleted: PARAMS.confirm is ' + PARAMS.confirm + ' but this instance is ' + instance);
        var complete = true;
        for (var i = 0; i < STEPS.length && complete; i++) complete = clear(STEPS[i]);
        var end = complete ? 'complete' : refused ? 'stopped at a refused delete' : 'stopped at its cap or time budget: run it again to go on';
        say('deleted ' + JSON.stringify(deleted) + ', ' + refused + ' refused; ' + end);
    }

    run();
})();
```

**Verify**: `node --check tools/scale/cleanup-fleet.js; echo "exit $?"` → `exit 0`. And
`grep -c "confirm: ''" tools/scale/cleanup-fleet.js` → `1`.

### Step 4: Create the dry run and run it

Create `tools/scale/dry-run.mjs` with exactly this content. It runs both scripts against tables in
memory. It is the only way this plan executes them.

```js
/* global console, URL */
/*
 * Runs tools/scale/generate-fleet.js and cleanup-fleet.js against tables in memory, with no instance:
 * `node tools/scale/dry-run.mjs`. It shows the guards refuse, the row counts add up, a second run creates nothing,
 * a capped run goes on where it stopped, and the cleanup removes the generated rows and nothing else.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8')
const GENERATE = read('./generate-fleet.js')
const CLEANUP = read('./cleanup-fleet.js')

const REFERENCES = { asset: 'alm_hardware', customer: 'customer_account' }
const INSTANCE = 'dev-dry-run'

function instance({ provider = 'Demo NaaS Provider' } = {}) {
    const tables = {
        core_company: [{ sys_id: 'provider', name: provider }],
        cmdb_hardware_product_model: ['C9300-48P-E', 'MR46-HW', 'FG-60F'].map((pid) => ({ sys_id: `model-${pid}`, x_daas_ham_oem_pid: pid })),
    }
    const logs = []
    let ids = 0
    const rowsOf = (table) => (tables[table] ??= [])
    const valueOf = (row, field) => {
        const [first, ...rest] = field.split('.')
        if (!rest.length) return String(row[first] ?? '')
        const target = rowsOf(REFERENCES[first]).find((found) => found.sys_id === row[first])
        return target ? valueOf(target, rest.join('.')) : ''
    }

    class GlideRecord {
        constructor(table) {
            this.table = table
            this.conditions = []
            this.limit = Infinity
            this.found = []
            this.at = -1
            this.row = {}
        }
        addQuery(field, operator, value) {
            this.conditions.push(value === undefined ? [field, '=', operator] : [field, operator, value])
        }
        setLimit(limit) {
            this.limit = limit
        }
        query() {
            const matches = (row) =>
                this.conditions.every(([field, operator, value]) =>
                    operator === 'STARTSWITH' ? valueOf(row, field).startsWith(String(value)) : valueOf(row, field) === String(value),
                )
            this.found = rowsOf(this.table).filter(matches).slice(0, this.limit)
            this.at = -1
        }
        next() {
            this.at++
            this.row = this.found[this.at] ?? {}
            return this.at < this.found.length
        }
        getRowCount() {
            return this.found.length
        }
        get(field, value) {
            const [name, wanted] = value === undefined ? ['sys_id', field] : [field, value]
            const row = rowsOf(this.table).find((found) => String(found[name] ?? '') === String(wanted))
            this.row = row ?? {}
            return Boolean(row)
        }
        initialize() {
            this.row = {}
        }
        setValue(field, value) {
            this.row[field] = value
        }
        getValue(field) {
            return this.row[field] === undefined ? null : String(this.row[field])
        }
        getUniqueValue() {
            return this.row.sys_id ?? ''
        }
        insert() {
            this.row = { ...this.row, sys_id: `id${++ids}` }
            rowsOf(this.table).push(this.row)
            return this.row.sys_id
        }
        deleteRecord() {
            tables[this.table] = rowsOf(this.table).filter((row) => row !== this.row)
            return true
        }
        getLastErrorMessage() {
            return ''
        }
    }

    class GlideDateTime {
        getValue() {
            return '2026-11-12 12:00:00'
        }
    }

    const properties = { instance_name: INSTANCE, 'x_daas_ham.provider_company': 'provider' }
    const gs = {
        getProperty: (name, fallback = '') => properties[name] ?? fallback,
        getUserID: () => 'runner',
        info: (message) => void logs.push(message),
    }
    const assets = {
        newAsset: (model, stage) => {
            const asset = new GlideRecord('alm_hardware')
            asset.initialize()
            asset.setValue('model', model)
            asset.setValue('stage', stage)
            asset.setValue('x_daas_ham_fleet', true)
            return asset
        },
    }
    const run = (script, params) => {
        new Function('GlideRecord', 'GlideDateTime', 'gs', 'require', 'SCALE_PARAMS', script)(GlideRecord, GlideDateTime, gs, () => assets, params)
        return logs[logs.length - 1]
    }
    const count = (table) => rowsOf(table).length
    return { run, count, rowsOf }
}

const SHAPE = { customers: 2, sitesPerCustomer: 3, assetsPerSite: 5, maxAssetsPerRun: 2000, budgetSeconds: 120, assetsModule: 'assets' }
const GENERATED = {
    customer_account: 2,
    x_daas_ham_agreement: 2,
    cmn_location: 6,
    x_daas_ham_subscription_line: 6,
    alm_hardware: 30,
    x_daas_ham_service_interval: 30,
}
const counts = (dev) => Object.fromEntries(Object.keys(GENERATED).map((table) => [table, dev.count(table)]))
const NOTHING = Object.fromEntries(Object.keys(GENERATED).map((table) => [table, 0]))

{
    const dev = instance()
    assert.match(dev.run(GENERATE, { ...SHAPE, confirm: '' }), /nothing written: PARAMS\.confirm is empty/)
    assert.match(dev.run(GENERATE, { ...SHAPE, confirm: 'production' }), /nothing written: PARAMS\.confirm is production but this instance is dev-dry-run/)
    assert.deepEqual(counts(dev), NOTHING, 'an unconfirmed run writes nothing')
}
{
    const inUse = instance({ provider: 'A real provider' })
    assert.match(inUse.run(GENERATE, { ...SHAPE, confirm: INSTANCE }), /nothing written: the Provider of this instance is not Demo NaaS Provider/)
    assert.deepEqual(counts(inUse), NOTHING, 'an instance in use is not written to')
}
{
    const dev = instance()
    assert.match(dev.run(GENERATE, { ...SHAPE, confirm: INSTANCE }), /0 refused, in \d+ s; complete$/)
    assert.deepEqual(counts(dev), GENERATED, 'a full run creates every row once')
    const serials = dev.rowsOf('alm_hardware').map((asset) => asset.serial_number)
    assert.equal(new Set(serials).size, 30, 'every serial is its own')
    assert.equal(serials[0], 'SCALE00010010001')
    assert.equal(serials[29], 'SCALE00020030005')
    assert.match(dev.run(GENERATE, { ...SHAPE, confirm: INSTANCE }), /created \{\}, 0 refused, in \d+ s; complete$/)
    assert.deepEqual(counts(dev), GENERATED, 'a second run creates nothing')

    assert.match(dev.run(CLEANUP, { confirm: '', maxRowsPerRun: 5000, budgetSeconds: 120 }), /nothing deleted: PARAMS\.confirm is empty/)
    assert.deepEqual(counts(dev), GENERATED, 'an unconfirmed cleanup deletes nothing')
    let runs = 0
    let last = ''
    do {
        last = dev.run(CLEANUP, { confirm: INSTANCE, maxRowsPerRun: 20, budgetSeconds: 120 })
        runs++
    } while (!/complete$/.test(last) && runs < 10)
    assert.equal(runs, 4, 'a capped cleanup goes on over 4 runs of 20 rows')
    assert.deepEqual(counts(dev), NOTHING, 'the cleanup removes every generated row')
    assert.equal(dev.count('core_company'), 1, 'the cleanup leaves the Provider')
    assert.equal(dev.count('cmdb_hardware_product_model'), 3, 'the cleanup leaves the Models')
}
{
    const dev = instance()
    const capped = { ...SHAPE, confirm: INSTANCE, maxAssetsPerRun: 7 }
    assert.match(dev.run(GENERATE, capped), /stopped at its cap or time budget: run it again to go on$/)
    assert.equal(dev.count('alm_hardware'), 7, 'a capped run stops at its cap')
    let runs = 1
    while (!/complete$/.test(dev.run(GENERATE, capped)) && runs < 10) runs++
    assert.equal(runs + 1, 5, 'a capped run of 7 assets completes 30 in 5 runs')
    assert.deepEqual(counts(dev), GENERATED, 'the capped runs create every row once')
}

console.log('dry run ok: 2 customers, 2 agreements, 6 sites, 6 lines, 30 assets, 30 intervals; rerun 0; capped 5 runs; cleanup 4 runs')
```

**Verify**: `node tools/scale/dry-run.mjs; echo "exit $?"` prints exactly

```text
dry run ok: 2 customers, 2 agreements, 6 sites, 6 lines, 30 assets, 30 intervals; rerun 0; capped 5 runs; cleanup 4 runs
exit 0
```

Then `npx eslint tools; echo "exit $?"` → `exit 0`.

An `AssertionError` from the dry run names the property that failed. Compare the file you created
with the plan's text before you change anything: the three files were run as given.

### Step 5: Show that the prototype is no part of the app package

Run `npm run build`, then `grep -rl "NAAS_SCALE" dist src; echo "exit $?"`.

**Verify**: the build ends with `Build completed successfully`. The grep prints no file name and
`exit 1`. Then `git status --short` shows no change under `src/` (in particular
`src/fluent/generated/keys.ts` is unchanged).

Commit the three files under `tools/scale/`.

### Step 6: Write the design doc

Create `docs/research/scale-test.md` with the content below. Copy it as given. Where step 1 showed
you a fact that differs, correct that fact in the doc and say so in your report. Do not fill in an
open question, and do not turn a proposed threshold into an agreed one.

````md
# Scale test: design draft

## Status

A draft for the owner to decide on. Nothing in it has run on an instance. The generator in
`tools/scale/` is a prototype that has run only against tables in memory
(`node tools/scale/dry-run.mjs`). Every number under "Thresholds" is a proposal. The section "Open
questions for the owner" lists what must be answered before a run.

## What the plan asks for

`plan.md` sets the goal of 100k to 1M hardware assets, and section 16 promises a scale test: "a
dev-only generator script creates ~200k assets in the demo dataset. Every job and the key list views
are timed before each phase is signed off." Risk R6 names the cost of the before-query business
rules at 1M rows, to be settled by that test. Today there is no generator, and the "Scale" entry of
`docs/verify-on-instance.md` is a manual check with no numbers.

This draft differs from `plan.md` in one point. The generator is not in the demo dataset. It is a
script under `tools/scale/`, outside the app package, so no install can carry it to production.

## What is measured

Jobs whose work grows with the fleet. The scheduled jobs are the `ScheduledScript` records in
`src/fluent/*/`. ADR 0007 says how each bounds its work.

| Job | How it bounds its work | With the prototype's data |
|---|---|---|
| *NaaS - reconcile installed base* | Job cursor `reconcile_installed_base` | walks every in-service asset |
| *NaaS - raise refresh orders* | 2000 candidates a run (`CANDIDATES_PER_RUN`, `platform/refresh.ts`) and the time budget | reads every asset due within the horizon |
| *NaaS - roll lifecycle phases* | queues an event per Model with a milestone that day | three Models carry the whole fleet |
| *NaaS - open last month billing period*, then the billing generation | pass token `billing_generate_<period sys_id>` | one Service interval per asset |
| *Recompute margin* (form button) | superseding pass `margin_<period sys_id>` under a job lock (ADR 0013) | one period over every asset |
| *NaaS - in-service detection* | Job cursor `in_service_detection` | nothing to do: no asset is pending in service |
| *NaaS - spare pool top-up* | Job cursor `spare_pool_top_up` | nothing to do: the Agreements have a spare ratio of 0 |
| *NaaS - chase overdue returns* | Job cursor `chase_overdue_returns` | nothing to do: no Return is in flight |

The other scheduled jobs (*raise attestations*, *agreement renewal and coverage expiry warnings*,
*review leases*, *raise agreement-end and temporary-end returns*, *purge old device events*,
*normalize discovered models*) were not read for this draft. Read each one's module before timing
it. The four OEM sync jobs call vendor clouds and are left out.

List views. The before-query rules (`src/fluent/shared/visibility.now.ts`) narrow 15 tables, among
them `alm_hardware`, `x_daas_ham_order`, `x_daas_ham_subscription_line` and `x_daas_ham_shipment`.
The workspace reads a list through the Table API (`sysparm_query`, `sysparm_fields`,
`sysparm_display_value=all`, `sysparm_limit`, `sysparm_offset`; `src/client/lib/sn.ts`) and its
counts through the Aggregate API (`sysparm_count`). So the views are timed as those requests:

- the *Installed base* lists of `src/client/workspace/catalog.ts` over `alm_hardware`
  (`assets_in_service`, `assets_refresh_due`, `assets_data_gaps`): the first page, a deep page, and
  the count;
- the same requests as four readers: an administrator, a provider staff user, an inventory tech
  (narrowed to stockrooms) and a Customer admin of one generated Customer (narrowed to one company,
  which is R6);
- the customer page's equipment, which reads up to 5000 assets in one request
  (`platform/customer-page.ts`).

## The generated data

`tools/scale/generate-fleet.js` creates, in the shapes of `src/server/entry/demo-seed.ts`:

| Table | Key | Count |
|---|---|---|
| `customer_account` | name `Scale Customer 0001` | `customers` |
| `x_daas_ham_agreement` | its Customer | one a Customer, active, spare ratio 0 |
| `cmn_location` (a Site) | name `Scale Site 0001-001` | `sitesPerCustomer` a Customer |
| `x_daas_ham_subscription_line` | description `Scale Site 0001-001 package` | one site package a Site, active |
| `alm_hardware` | serial `SCALE` + Customer (4 digits) + Site (3) + unit (4) | `assetsPerSite` a Site, in service |
| `x_daas_ham_service_interval` | its asset | one an asset |

Assets are made by the app's own `newAsset` (`platform/assets.ts`), in turn over three demo Models
(`C9300-48P-E`, `MR46-HW`, `FG-60F`), so the demo data must be loaded first. Inserts run with
business rules on, as the demo data's do.

A fleet of 200,000 is for example `customers: 100, sitesPerCustomer: 40, assetsPerSite: 50`. The
serial format allows 9999 Customers, 999 Sites a Customer and 9999 assets a Site.

Not generated by the prototype: free stock and spare pools, assets pending in service, Orders and
Returns in flight, leases, OEM coverage, device events, and closed Billing periods.

## Where the generator runs

In *Scripts - Background* on a dev instance, in the scope `x_daas_ham`. It is pasted in by hand with
its parameters edited at the top. It refuses to write unless both hold:

- `PARAMS.confirm` equals the instance's `instance_name` property. The default is empty.
- The Provider company (`x_daas_ham.provider_company`) is the demo's, *Demo NaaS Provider*. This is
  the test `demo-seed.ts` uses, since `glide.installation.production` reads true on a personal
  developer instance too.

A run stops after `maxAssetsPerRun` assets or `budgetSeconds` seconds. Run again, it finds each row
by its key and goes on where it stopped. A finished run creates nothing. So a run that is cut off
does no harm, and 200,000 assets take about 100 runs at the default cap of 2000.

## How a run is timed

Proposed. None of it has been tried on an instance.

- A job with a Job cursor: press *Execute now*, then read its row in *Job cursor*. *Processed (last
  run)* over the time budget (`x_daas_ham.job.budget_seconds`, 120 by default) is its throughput.
  The number of runs until *Last status* reads *complete* is the length of a pass.
- A job without a cursor: call its function from *Scripts - Background* and log the elapsed time, in
  the way the ATF tests load a module by its installed path. For example `raiseRefreshOrders` of
  `platform/refresh.ts`.
- Billing generation and the margin recompute: the time from the button or the job to *complete* on
  the pass's Job cursor row, and the number of lines written.
- A list request: five calls with `curl -w '%{time_total}'`, the median and the worst recorded. The
  operator supplies the credentials at run time. They go into no file.

Each measurement is recorded with the instance, the date, the fleet size and the three shape
parameters, so that a later run can be compared.

## Thresholds (proposed, not agreed)

These are starting points for the owner, not requirements.

- The first page of a workspace list, and its count: a median of 2 s and a worst of 5 s, for each of
  the four readers, at 200,000 and at 1,000,000 assets.
- The customer page's equipment: 5 s for a Customer with 5000 assets.
- A scheduled run of a chunked job ends within its time budget plus 30 s, and a whole pass completes
  within a day of daily runs.
- Billing generation of one month, and one margin recompute: each within one hour at 200,000 assets.
- No run ends with failed records that a smaller fleet does not have.

Once agreed, the numbers and the measured results go into the "Scale" entry of
`docs/verify-on-instance.md`.

## Cleanup

`tools/scale/cleanup-fleet.js` deletes what the generator inserted, children first, by the `Scale`
and `SCALE` names, a capped number of rows a run. It refuses without `PARAMS.confirm`, and it stops
at the first delete the instance refuses and says which row.

It does not remove what the jobs derive from those rows during the timing: Billing periods and
lines, Cost facts and Margin rows, reconciliation exceptions, attestations, refresh Orders, and the
CIs the platform creates for assets. A closed Billing period refuses changes by design. For that
reason the proposal is to run the test on a disposable instance and to discard it afterwards, with
the cleanup script as a convenience for a smoke run only.

## Run protocol (only after the owner approves)

Each step writes to an instance. None is taken without the owner's approval, naming the instance.

1. Smoke run. Install the app with demo data on the chosen dev instance and load the demo data.
   Run the generator with `customers: 1, sitesPerCustomer: 2, assetsPerSite: 10`. This settles the
   unknowns below.
2. Check the 20 assets by hand: each is a fleet asset in service, at its Site, on its Subscription
   line, with one Service interval. Run the cleanup and check that nothing named `Scale` is left.
3. Measure the generator's rate on a run of 2000 assets. Decide from it how the full fleet is
   loaded.
4. Generate the agreed fleet. Time the jobs and the list requests. Record the results.
5. Discard the instance, or clean up as agreed.

Unknowns the smoke run settles:

- whether `require` resolves a module path in *Scripts - Background* (it does in ATF script steps);
- whether the scoped script reads the `instance_name` property (if not, the guard refuses and
  nothing is written);
- whether an asset inserted in service gets a Service interval from the rule *NaaS - start or stop
  billing on service*, in which case the generator finds it and inserts none;
- whether a background script of this length is cut off by the instance before its own time budget;
- how many assets a second the instance inserts with every rule on.

## Open questions for the owner

1. **Which instance?** The run needs a dev instance that may be discarded. A personal developer
   instance may be too small for 200,000 assets and their CIs.
2. **Which volume?** `plan.md` says about 200k for the test and 1M for the goal and for R6. One
   size, or both?
3. **Which shape?** Few large Customers or many small ones changes what the before-query rules
   cost. What does the real fleet look like: Customers, Sites a Customer, assets a Site?
4. **CIs or not?** With the demo Models' category, the platform creates a CI for every asset. That
   doubles the rows and slows the load. Is that the realistic case to measure?
5. **Rules on or off during the load?** With rules on, the data is what the app would create, and
   the load is slow. With `setWorkflow(false)` it is fast, and the rows the rules derive are
   missing.
6. **Which thresholds?** The proposals above are placeholders. What must a list and a job do to
   pass?
7. **Which other populations?** Free stock, assets pending in service, Returns in flight, leases,
   device events and closed Billing periods are not generated. Which of them must be, for the jobs
   that have nothing to do today?
8. **How is the full fleet loaded?** About 100 runs by hand for 200,000 assets is not practical.
   A loop on the dev instance (a job created there by hand, never shipped) is one option.
9. **Does `plan.md` change?** It says the generator is in the demo dataset. This draft keeps it out
   of the app package. Should `plan.md` say so?
````

**Verify**:
`grep -c "^## " docs/research/scale-test.md` → `10`.
`grep -c "^[0-9]*\. \*\*" docs/research/scale-test.md` → `9` (the nine open questions).
`grep -n "TODO\|TBD" docs/research/scale-test.md` → prints nothing.

### Step 7: Point the instance checklist at the draft

In `docs/verify-on-instance.md`, at the end of the subsection "### Scale" (after the paragraph that
ends `only where the OEM claim run's check for stranded steps goes on from, with no status.` and
before the heading `## Fleet (ADR 0016)`), add a blank line and this paragraph:

```md
A generator for a dev instance and a timing protocol are drafted in
[research/scale-test.md](research/scale-test.md), with the prototype in `tools/scale/`. Neither has
run on an instance, and no threshold is agreed yet.
```

Change nothing else in that file.

**Verify**: `grep -c "research/scale-test.md" docs/verify-on-instance.md` → `1`.

### Step 8: Run the gate and commit

Run `npm run check`.

**Verify**: exit 0, no failed test. `git status --short` lists, apart from anything under `plans/`,
only `docs/research/scale-test.md` (new) and `docs/verify-on-instance.md` (modified). Commit them.

### Step 9: Hand back and stop

Report to the operator:

1. The files created, and the dry-run line.
2. The nine open questions of the design doc, word for word.
3. That nothing has run on an instance, and that the next action (the smoke run in the doc's "Run
   protocol") needs the operator's approval, naming the instance.

Then stop. Do not start the run protocol, even if you have access to an instance.

## Test plan

- `tools/scale/dry-run.mjs` is the prototype's test. It asserts, on in-memory tables:
  - an empty or wrong `confirm` writes nothing, and says why;
  - an instance whose Provider is not the demo's is not written to;
  - a full run of 2 Customers, 3 Sites each and 5 assets a Site creates 2, 2, 6, 6, 30 and 30 rows,
    with the first serial `SCALE00010010001` and the last `SCALE00020030005`;
  - a second run creates nothing;
  - a run capped at 7 assets stops there and completes over 5 runs;
  - the cleanup refuses without `confirm`, removes every generated row over 4 capped runs, and
    leaves the Provider and the Models.
- It is a plain Node script, not a vitest file: `vitest.config.ts` includes only `src/**`, and the
  prototype stays outside the app's test suite on purpose.
- No test covers behaviour on an instance. The design doc lists what the first smoke run must show.
- Verification: `node tools/scale/dry-run.mjs` → the `dry run ok:` line, exit 0.

## Done criteria

All local. ALL must hold:

- [ ] `node tools/scale/dry-run.mjs` exits 0 and prints the `dry run ok:` line of step 4
- [ ] `npx eslint tools` exits 0
- [ ] `npm run check` exits 0
- [ ] `grep -rl "NAAS_SCALE" dist src` prints nothing
- [ ] `grep -c "confirm: ''" tools/scale/generate-fleet.js tools/scale/cleanup-fleet.js` prints `1` for each file
- [ ] `docs/research/scale-test.md` exists with 10 `## ` sections and 9 numbered open questions
- [ ] `grep -c "research/scale-test.md" docs/verify-on-instance.md` prints `1`
- [ ] `git diff --stat 1864b17..HEAD -- src` shows no change made by this plan
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] Nothing was run against an instance, and the report says so
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any step would contact an instance: `npm run deploy`, `now-sdk install`, a script pasted into
  *Scripts - Background*, a Table API call, an ATF run. Bulk writes to an instance are hard to
  reverse. They need the operator's approval, naming the instance, and they are not part of this
  plan.
- A fact in step 1 differs from the expected result (other than the version).
- `node tools/scale/dry-run.mjs` fails twice after you have compared your files with the plan's text.
- After the build, `grep -rl "NAAS_SCALE" dist src` prints a file. The prototype has reached the app
  package, which it must never do.
- `npm run lint` reports an error under `tools/` that the `/* global ... */` comments do not cover.
  Do not edit `eslint.config.js` to get past it.
- You find yourself wanting to put the generator under `src/`, to wire it as a scheduled job, or to
  change `demo-seed.ts`.
- You are asked, or tempted, to answer an open question of the doc yourself. They are the owner's.

## Maintenance notes

- The generator's `assetsModule` default names the version in `package.json`. Nothing checks it
  (unlike the ATF scripts, which `built-metadata.test.ts` holds to the built modules). Update it by
  hand with the version, or pass the right path in `PARAMS`.
- The generator mirrors `demo-seed.ts` by hand: the tables, the key of each row and the asset
  fields. A change to how the demo data creates an Agreement, a Subscription line, an in-service
  asset or a Service interval should reach `tools/scale/generate-fleet.js`. The dry run cannot see
  such drift, as its tables accept any field.
- The cleanup removes only what the generator inserted. Rows the jobs derive from them (billing
  lines, Cost facts, exceptions, the CIs the platform creates for assets) are an open question of
  the doc.
- `tools/` is new as a tracked folder. If it grows, the README's layout section should name it.
  That edit is left out of this spike.
- Follow-up, once the owner has answered the open questions: a plan for the measured run (smoke
  run, generation, timing, recording the agreed thresholds in `docs/verify-on-instance.md`,
  cleanup). It must carry the same STOP before any instance write.
- Reviewer: check that both scripts ship with `confirm: ''`, that no instance name or credential is
  in any file, and that the doc calls its numbers proposals.
