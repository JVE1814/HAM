import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * The instance stores a record's name in a column of fixed length and cuts a longer one off without a warning: the
 * build and the install pass, and the rule list then shows "NaaS - start or stop billing on service " with no way to
 * tell two such rules apart. The lengths are the instance's (sys_dictionary): sys_script, sys_ui_action, sysrule (script
 * actions and email notifications), contract_sla, sys_rest_message, sys_ws_definition and sys_ws_operation hold 40
 * characters; sysauto (scheduled scripts) and sys_properties 100.
 */

const FLUENT = new URL('../fluent/', import.meta.url).pathname

/** The longest name each Fluent call may give its record. */
const NAME_LIMIT: Readonly<Record<string, number>> = {
    BusinessRule: 40,
    UiAction: 40,
    ScriptAction: 40,
    EmailNotification: 40,
    Sla: 40,
    RestMessage: 40,
    RestApi: 40,
    ScheduledScript: 100,
    Property: 100,
}

function nowFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return entry.name === 'generated' ? [] : nowFiles(path)
        return entry.name.endsWith('.now.ts') ? [path] : []
    })
}

interface NamedRecord {
    call: string
    name: string
}

/**
 * The names a Fluent source gives its records. Each call opens at the start of a line (`BusinessRule({`, or after
 * `export const x = `) and closes with `})` at the start of a line, as the formatter writes it; the record's name is
 * the `name` property one indent in. A REST API also names each route, deeper in, under the same limit.
 */
function namedRecords(source: string): NamedRecord[] {
    return [...source.matchAll(/^(?:export const \w+ = )?(\w+)\(\{\n([\s\S]*?)^\}\)/gm)].flatMap(([, call, body]) => {
        if (!(call in NAME_LIMIT)) return []
        const property = call === 'RestApi' ? /^\s+name:\s*'((?:[^'\\]|\\.)*)'/gm : /^ {4}name:\s*'((?:[^'\\]|\\.)*)'/gm
        return [...body.matchAll(property)].map(([, name]) => ({ call, name: name.replace(/\\(.)/g, '$1') }))
    })
}

describe('record names', () => {
    it('reads the names of the records a source declares', () => {
        const source = [
            "BusinessRule({\n    $id: Now.ID['a'],\n    name: 'NaaS - a rule',\n    script: run,\n})",
            "export const b = UiAction({\n    name: 'It\\'s an action',\n    form: { name: 'not a record name' },\n})",
            "Acl({\n    name: 'ignored',\n})",
            "RestApi({\n    name: 'NaaS API',\n    routes: [\n        {\n            name: 'a route',\n        },\n    ],\n})",
        ].join('\n\n')
        expect(namedRecords(source)).toEqual([
            { call: 'BusinessRule', name: 'NaaS - a rule' },
            { call: 'UiAction', name: "It's an action" },
            { call: 'RestApi', name: 'NaaS API' },
            { call: 'RestApi', name: 'a route' },
        ])
    })

    it('fit the column the instance stores them in', () => {
        const files = nowFiles(FLUENT)
        const records = files.flatMap((file) => namedRecords(readFileSync(file, 'utf8')).map((record) => ({ file, ...record })))
        expect(records.filter((record) => record.call === 'BusinessRule').length).toBeGreaterThan(40)
        const tooLong = records
            .filter(({ call, name }) => name.length > NAME_LIMIT[call])
            .map(({ file, call, name }) => `${relative(FLUENT, file)}: ${call} '${name}' (${name.length} > ${NAME_LIMIT[call]})`)
        expect(tooLong).toEqual([])
    })
})
