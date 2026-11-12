import '@servicenow/sdk/global'
import { Test } from '@servicenow/sdk/core'

/*
 * Job locks (ADR 0013) as the instance keeps them, which the unit tests' stand-in for Glide only assumes: the unique
 * index on Lock refuses a second row without throwing, a row made by hand holds the lock, a run leaves no row behind,
 * and a row older than ABANDONED_AFTER_MINUTES (domain/job-lock) is cleared by the next take. Each step takes a lock
 * name of its own, made for the run, so it meets no job and no other run of the test. A step probes its lock through
 * platform/locks before it writes: the first failure it can report is that the lock is not free.
 */
export const jobLockTest = Test(
    {
        $id: Now.ID['atf_job_lock'],
        name: 'NaaS - a job lock is one row that only one holder takes',
        description:
            'Under lock names of its own: a second Job lock row of one name is refused without throwing, and a row made by hand holds the lock until it is deleted; a run through withLock holds one row, refuses a nested take and leaves no row, also when its work throws; a row created a day ago is cleared by the next take, which runs.',
        active: true,
        // A take that finds its lock held logs each refused insert as a Unique Key violation error: the expected path.
        failOnServerError: false,
    },
    (atf) => {
        atf.server.runServerSideScript({
            $id: Now.ID['atf_jl_unique'],
            script: `(function (outputs, steps, params, stepResult, assertEqual) {
    var locks = require('x_daas_ham/naas-ham/0.1.0/src/server/platform/locks.ts');
    var TABLE = 'x_daas_ham_job_lock';
    var NAME = 'atf_lock_unique_' + gs.generateGUID();
    var touched = false;
    function insertRow() {
        var row = new GlideRecord(TABLE);
        row.initialize();
        row.setValue('name', NAME);
        return row.insert();
    }
    function rowCount() {
        var row = new GlideRecord(TABLE);
        row.addQuery('name', NAME);
        row.query();
        return row.getRowCount();
    }
    function clear() {
        var row = new GlideRecord(TABLE);
        row.addQuery('name', NAME);
        row.query();
        while (row.next()) row.deleteRecord();
    }
    try {
        if (locks.isLocked(NAME) !== false) throw new Error('expected the lock ' + NAME + ' to be free before the test');
        touched = true;
        if (!insertRow()) throw new Error('The first lock row was refused');
        var second = null;
        try {
            second = insertRow();
        } catch (e) {
            throw new Error('A second row of the same name threw instead of being refused: ' + e);
        }
        if (second) throw new Error('A second row of the same name was inserted: Job lock has no unique index on Lock');
        if (rowCount() !== 1) throw new Error('Job lock holds ' + rowCount() + ' rows of one name, not 1');
        if (locks.isLocked(NAME) !== true) throw new Error('A fresh row made by hand does not hold the lock');
        var ran = false;
        var attempt = locks.withLock(NAME, function () { ran = true; return true; });
        if (ran || attempt.ran !== false) throw new Error('withLock ran its work while a row made by hand held the lock');
        if (rowCount() !== 1) throw new Error('A take cleared a fresh lock row');
        clear();
        var after = locks.withLock(NAME, function () { return 'ran'; });
        if (after.ran !== true || after.value !== 'ran') throw new Error('withLock did not run once the row made by hand was deleted');
        stepResult.setOutputMessage('A second row named ' + NAME + ' was refused without throwing; held by hand, the lock was not taken; deleted, it was');
        return true;
    } catch (e) {
        stepResult.setOutputMessage(String(e && e.message ? e.message : e));
        return false;
    } finally {
        if (touched) clear();
    }
})(outputs, steps, params, stepResult, assertEqual);`,
        })
        atf.server.runServerSideScript({
            $id: Now.ID['atf_jl_run'],
            script: `(function (outputs, steps, params, stepResult, assertEqual) {
    var locks = require('x_daas_ham/naas-ham/0.1.0/src/server/platform/locks.ts');
    var TABLE = 'x_daas_ham_job_lock';
    var NAME = 'atf_lock_run_' + gs.generateGUID();
    var touched = false;
    function rowCount() {
        var row = new GlideRecord(TABLE);
        row.addQuery('name', NAME);
        row.query();
        return row.getRowCount();
    }
    function clear() {
        var row = new GlideRecord(TABLE);
        row.addQuery('name', NAME);
        row.query();
        while (row.next()) row.deleteRecord();
    }
    try {
        if (locks.isLocked(NAME) !== false) throw new Error('expected the lock ' + NAME + ' to be free before the test');
        touched = true;
        var inside = null;
        var run = locks.withLock(NAME, function (lock) {
            inside = {
                held: lock.held(),
                rows: rowCount(),
                locked: locks.isLocked(NAME),
                nested: locks.withLock(NAME, function () { return true; }).ran
            };
            return 'done';
        });
        if (run.ran !== true || run.value !== 'done') throw new Error('withLock did not run its work on a free lock');
        if (inside.held !== true || inside.rows !== 1 || inside.locked !== true) throw new Error('The work did not hold one lock row: ' + JSON.stringify(inside));
        if (inside.nested !== false) throw new Error('A nested take of the lock ran: locks are not re-entrant');
        if (rowCount() !== 0) throw new Error('A run that ended left its lock row behind');
        var escaped = false;
        try {
            locks.withLock(NAME, function () { throw new Error('ATF work failed'); });
        } catch (e) {
            escaped = true;
        }
        if (!escaped) throw new Error('What the work threw did not escape withLock');
        if (rowCount() !== 0) throw new Error('Work that threw left its lock row behind');
        stepResult.setOutputMessage('A run held ' + NAME + ' as one row, a nested take was refused, and no row was left, also after work that threw');
        return true;
    } catch (e) {
        stepResult.setOutputMessage(String(e && e.message ? e.message : e));
        return false;
    } finally {
        if (touched) clear();
    }
})(outputs, steps, params, stepResult, assertEqual);`,
        })
        atf.server.runServerSideScript({
            $id: Now.ID['atf_jl_abandoned'],
            script: `(function (outputs, steps, params, stepResult, assertEqual) {
    var locks = require('x_daas_ham/naas-ham/0.1.0/src/server/platform/locks.ts');
    var TABLE = 'x_daas_ham_job_lock';
    var NAME = 'atf_lock_abandoned_' + gs.generateGUID();
    var touched = false;
    function rowCount() {
        var row = new GlideRecord(TABLE);
        row.addQuery('name', NAME);
        row.query();
        return row.getRowCount();
    }
    function clear() {
        var row = new GlideRecord(TABLE);
        row.addQuery('name', NAME);
        row.query();
        while (row.next()) row.deleteRecord();
    }
    try {
        if (locks.isLocked(NAME) !== false) throw new Error('expected the lock ' + NAME + ' to be free before the test');
        touched = true;
        var dayAgo = new GlideDateTime();
        dayAgo.addSeconds(-86400);
        var row = new GlideRecord(TABLE);
        row.initialize();
        row.setValue('name', NAME);
        row.setValue('sys_created_on', dayAgo.getValue());
        var id = row.insert();
        if (!id) throw new Error('The back-dated lock row was refused');
        var stored = new GlideRecord(TABLE);
        if (!stored.get(id)) throw new Error('The back-dated lock row was not found again');
        var hourAgo = new GlideDateTime();
        hourAgo.addSeconds(-3600);
        var created = String(stored.getValue('sys_created_on'));
        if (created >= hourAgo.getValue()) throw new Error('NOT BACK-DATED: the instance stamped the row ' + created + ', so this step cannot age a lock; check an abandoned lock by hand (docs/verify-on-instance.md, Job locks)');
        if (locks.isLocked(NAME) !== false) throw new Error('An abandoned lock row counts as held');
        var run = locks.withLock(NAME, function () {
            var old = new GlideRecord(TABLE);
            return old.get(id) ? 'kept' : 'cleared';
        });
        if (run.ran !== true) throw new Error('The take did not clear the abandoned lock and run');
        if (run.value !== 'cleared') throw new Error('The work ran beside the abandoned lock row, which was not cleared');
        if (rowCount() !== 0) throw new Error('A lock row was left behind after the abandoned one was taken over');
        stepResult.setOutputMessage('A lock row created ' + created + ' was cleared by the next take of ' + NAME + ', which ran and left no row');
        return true;
    } catch (e) {
        stepResult.setOutputMessage(String(e && e.message ? e.message : e));
        return false;
    } finally {
        if (touched) clear();
    }
})(outputs, steps, params, stepResult, assertEqual);`,
        })
    },
)
