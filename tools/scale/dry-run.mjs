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

function instance({ provider = 'Demo NaaS Provider', refuse = () => false } = {}) {
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
            if (refuse(this.table)) return ''
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
{
    let refusals = 1
    const dev = instance({ refuse: (table) => table === 'x_daas_ham_service_interval' && refusals-- > 0 })
    const full = { ...SHAPE, confirm: INSTANCE }
    const first = dev.run(GENERATE, full)
    assert.match(first, /1 refused/)
    assert.doesNotMatch(first, /complete$/, 'a run with a refused row is not complete')
    assert.equal(dev.count('x_daas_ham_service_interval'), 29, 'the refused interval is missing')
    assert.match(dev.run(GENERATE, full), /created \{"x_daas_ham_service_interval":1\}, 0 refused, in \d+ s; complete$/)
    assert.deepEqual(counts(dev), GENERATED, 'a rerun creates the refused interval')
}

console.log('dry run ok: 2 customers, 2 agreements, 6 sites, 6 lines, 30 assets, 30 intervals; rerun 0; capped 5 runs; refused interval retried; cleanup 4 runs')
