/* global GlideRecord, GlideDateTime, gs, require, SCALE_PARAMS */
/*
 * NAAS_SCALE_GENERATOR: a prototype, for a disposable dev instance only (docs/research/scale-test.md).
 * Paste into Scripts - Background, scope x_daas_ham, after the demo data is loaded. It is no part of the app package.
 * It creates Customers, Sites, Agreements, site-package Subscription lines and in-service fleet assets with their
 * Service intervals, each under a name that starts with Scale or SCALE. A run stops at its cap or time budget;
 * run it again and it goes on where it stopped. A run that had a row refused is not complete, and the next run
 * tries that row again. A complete run creates nothing more.
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

    function rowsWith(table, field, operator, value) {
        var record = new GlideRecord(table);
        record.addQuery(field, operator, value);
        record.query();
        return record.getRowCount();
    }

    /** False when the run's cap or budget was spent before the Site had all its assets. */
    function fillSite(assets, models, at, customer, agreement, site, line) {
        var sitePrefix = 'SCALE' + pad(at.customer, 4) + pad(at.site, 3);
        if (
            rowsWith('alm_hardware', 'serial_number', 'STARTSWITH', sitePrefix) >= PARAMS.assetsPerSite &&
            rowsWith('x_daas_ham_service_interval', 'site', '=', site) >= PARAMS.assetsPerSite
        ) {
            return true;
        }
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
            // A record is only looked up by its key on the next run, never repaired, so nothing is made under a refused parent.
            if (!customer) continue;
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
            if (!agreement) continue;
            for (var s = 1; s <= PARAMS.sitesPerCustomer && complete; s++) {
                var siteName = 'Scale Site ' + pad(c, 4) + '-' + pad(s, 3);
                var site = ensure('cmn_location', { name: siteName }, { company: customer, city: 'Scale City', x_daas_ham_is_site: true });
                if (!site) continue;
                var line = ensure('x_daas_ham_subscription_line', { description: siteName + ' package' }, {
                    agreement: agreement,
                    customer: customer,
                    line_type: 'site_package',
                    site: site,
                    monthly_rate: 100,
                    status: 'active',
                    start_date: '2026-02-01',
                });
                if (!line) continue;
                complete = fillSite(assets, models, { customer: c, site: s }, customer, agreement, site, line);
            }
        }
        var seconds = Math.round((new Date().getTime() - started) / 1000);
        var end = !complete
            ? 'stopped at its cap or time budget: run it again to go on'
            : refused
              ? 'not complete: run it again to retry what was refused'
              : 'complete';
        say('created ' + JSON.stringify(created) + ', ' + refused + ' refused, in ' + seconds + ' s; ' + end);
    }

    run();
})();
