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
