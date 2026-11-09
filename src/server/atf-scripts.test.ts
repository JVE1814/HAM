import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/*
 * The ATF tests' server-side scripts (src/fluent/tests, "Run Server Side Script" steps) only run on an instance, after a
 * build and install. What can go wrong before that is checked here:
 * - A script is one literal. The platform resolves no step output (`${step.record_id}`) in a script, as it does in
 *   other step inputs: the script variable has no element mapping provider, so a placeholder would reach the script as
 *   text.
 * - It compiles, and its harness runs: each script runs here against fakes of what it calls (the required modules,
 *   GlideRecord, gs) and must end in a verdict, never a TypeError of its own.
 * - It requires server modules by the path the instance keeps them under, as the SDK's generated wrappers do
 *   (<scope>/<package name>/<package version>/<file>): a version bump in package.json changes it. Each module exists
 *   and exports what the script calls.
 * - Every step and test id is unique, and every test is in one suite (`now-sdk cicd testsuite run` runs suites).
 */

const ROOT = new URL('../../', import.meta.url).pathname
const TESTS = join(ROOT, 'src/fluent/tests')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string; version: string }
const config = JSON.parse(readFileSync(join(ROOT, 'now.config.json'), 'utf8')) as { scope: string }
const MODULE_PREFIX = `${config.scope}/${pkg.name}/${pkg.version}/`

interface StepScript {
    file: string
    id: string
    /** The script's text, or null when it is not one literal. */
    script: string | null
}

const atfFiles = () =>
    readdirSync(TESTS)
        .filter((name) => name.endsWith('.now.ts'))
        .map((name) => join(TESTS, name))

function parse(file: string): ts.SourceFile {
    return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
    const found = object.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === name)
    return found && ts.isPropertyAssignment(found) ? found.initializer : undefined
}

function calls(source: ts.SourceFile, method: string): ts.CallExpression[] {
    const found: ts.CallExpression[] = []
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
            const callee = node.expression
            const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : ''
            if (name === method) found.push(node)
        }
        ts.forEachChild(node, visit)
    }
    visit(source)
    return found
}

/** Every runServerSideScript step of a Fluent test file. */
function stepScripts(file: string): StepScript[] {
    return calls(parse(file), 'runServerSideScript').map((call) => {
        const input = call.arguments[0]
        const object = input && ts.isObjectLiteralExpression(input) ? input : undefined
        const id = /Now\.ID\['([^']+)'\]/.exec(object ? (property(object, '$id')?.getText() ?? '') : '')?.[1] ?? ''
        const script = object ? property(object, 'script') : undefined
        const literal = script && (ts.isNoSubstitutionTemplateLiteral(script) || ts.isStringLiteral(script)) ? script.text : null
        return { file, id, script: literal }
    })
}

const SCRIPTS = atfFiles().flatMap(stepScripts)

/** The modules a script requires, with the name it binds each to. */
function requires(script: string): Array<{ binding: string; path: string }> {
    return [...script.matchAll(/\bvar\s+(\w+)\s*=\s*require\('([^']+)'\)/g)].map((m) => ({ binding: m[1], path: m[2] }))
}

function exportsOf(modulePath: string): Set<string> {
    const source = readFileSync(join(ROOT, modulePath.slice(MODULE_PREFIX.length)), 'utf8')
    return new Set([...source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/gm)].map((m) => m[1]))
}

/** A GlideRecord stand-in: every query finds one record. */
class FakeRecord {
    private found = false
    addQuery() {
        return { addOrCondition: () => undefined }
    }
    addEncodedQuery() {}
    addActiveQuery() {}
    setLimit() {}
    query() {}
    next() {
        this.found = !this.found
        return this.found
    }
    hasNext() {
        return true
    }
    get() {
        return true
    }
    getUniqueValue() {
        return 'a'.repeat(32)
    }
    getValue() {
        return 'FAKE'
    }
    getRowCount() {
        return 1
    }
}

/** A required module stand-in: each function replies HTTP 599 to a REST call, and beyondVisibility runs the read. */
function fakeModule(): unknown {
    return new Proxy(
        {},
        {
            get: (_target, name) => (...args: unknown[]): unknown => {
                if (name === 'beyondVisibility') return (args[1] as () => unknown)()
                const response = args[1] as { setStatus?: (status: number) => void; setBody?: (body: unknown) => void }
                response?.setStatus?.(599)
                response?.setBody?.({ error: 'fake' })
                return undefined
            },
        },
    )
}

/** Runs a script as the step does, against fakes; its verdict and output message. */
function runAgainstFakes(script: string): { verdict: unknown; message: string } {
    let message = ''
    const stepResult = { setOutputMessage: (text: string) => void (message = text) }
    const properties = new Map<string, string>()
    const gs = {
        getPropertySecured: (name: string, fallback: string) => properties.get(name) || fallback,
        setProperty: (name: string, value: string) => void properties.set(name, value),
        generateGUID: () => 'b'.repeat(32),
    }
    const body = script.replace(/^\(function/, 'return (function')
    const run = new Function('outputs', 'steps', 'params', 'stepResult', 'assertEqual', 'require', 'GlideRecord', 'gs', body)
    const verdict = run({}, () => ({}), {}, stepResult, () => undefined, fakeModule, FakeRecord, gs)
    return { verdict, message }
}

describe('ATF server-side scripts', () => {
    it('are found in the test files', () => {
        expect(SCRIPTS.length).toBeGreaterThanOrEqual(8)
        expect(SCRIPTS.every((step) => step.id)).toBe(true)
    })

    it('are each one literal, with no step output in them', () => {
        expect(SCRIPTS.filter((step) => step.script === null).map((step) => step.id)).toEqual([])
        expect(SCRIPTS.filter((step) => step.script?.includes('{{')).map((step) => step.id)).toEqual([])
    })

    it('wrap their body in the step function and pass or fail by its return', () => {
        for (const { id, script } of SCRIPTS) {
            expect(script, id).toMatch(/^\(function \(outputs, steps, params, stepResult, assertEqual\) \{/)
            expect(script, id).toMatch(/\}\)\(outputs, steps, params, stepResult, assertEqual\);$/)
            expect(script, id).toContain('return true;')
            expect(script, id).toContain('return false;')
        }
    })

    it('compile', () => {
        for (const { id, script } of SCRIPTS) {
            expect(() => new Function('outputs', 'steps', 'params', 'stepResult', 'assertEqual', script ?? ''), id).not.toThrow()
        }
    })

    it('require server modules by the path the instance keeps them under, and call only what they export', () => {
        for (const { id, script } of SCRIPTS) {
            const required = requires(script ?? '')
            expect(required.length, id).toBeGreaterThan(0)
            expect([...(script ?? '').matchAll(/\brequire\(/g)].length, `${id}: every require binds a var`).toBe(required.length)
            for (const { binding, path } of required) {
                expect(path.startsWith(`${MODULE_PREFIX}src/server/`), `${id}: ${path}`).toBe(true)
                expect(path.endsWith('.ts'), `${id}: ${path}`).toBe(true)
                expect(existsSync(join(ROOT, path.slice(MODULE_PREFIX.length))), `${id}: ${path}`).toBe(true)
                const exported = exportsOf(path)
                // Calls only, not the text of strings (a module path, a property name).
                const code = (script ?? '').replace(/'[^'\n]*'/g, "''")
                const used = [...code.matchAll(new RegExp(`\\b${binding}\\.(\\w+)`, 'g'))].map((m) => m[1])
                expect(used.length, `${id}: ${binding}`).toBeGreaterThan(0)
                expect(used.filter((name) => !exported.has(name)), `${id}: ${path}`).toEqual([])
            }
        }
    })

    it('run their harness to a verdict against fakes', () => {
        for (const { id, script } of SCRIPTS) {
            const { verdict, message } = runAgainstFakes(script ?? '')
            expect(typeof verdict, id).toBe('boolean')
            // A fake reply (HTTP 599) fails every check of a reply; a script that checks none passes.
            if (verdict === false) expect(message, id).toMatch(/expected HTTP/)
            expect(message, id).not.toMatch(/TypeError|ReferenceError|is not a function|undefined/)
        }
    })
})

describe('ATF test ids and suites', () => {
    const sources = atfFiles().map((file) => readFileSync(file, 'utf8'))

    it('name and describe each test within what the instance keeps (sys_atf_test name 100, description 1000)', () => {
        const tests = atfFiles().flatMap((file) =>
            calls(parse(file), 'Test').flatMap((call) => {
                const input = call.arguments[0]
                if (!input || !ts.isObjectLiteralExpression(input)) return []
                const text = (name: string) => {
                    const value = property(input, name)
                    return value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) ? value.text : ''
                }
                return [{ name: text('name'), description: text('description') }]
            }),
        )
        expect(tests.length).toBeGreaterThan(15)
        expect(tests.filter((test) => !test.name || test.name.length > 100).map((test) => test.name)).toEqual([])
        expect(tests.filter((test) => !test.description || test.description.length > 1000).map((test) => test.name)).toEqual([])
        expect(new Set(tests.map((test) => test.name)).size).toBe(tests.length)
    })

    it('give every test and step its own id', () => {
        const ids = sources.flatMap((source) => [...source.matchAll(/\$id: Now\.ID\['([^']+)'\]/g)].map((m) => m[1]))
        expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([])
    })

    it('put every test in exactly one suite', () => {
        const tests = sources.flatMap((source) => [...source.matchAll(/export const (\w+) = Test\(/g)].map((m) => m[1]))
        const inSuites = atfFiles().flatMap((file) =>
            calls(parse(file), 'TestSuite').flatMap((call) => {
                const input = call.arguments[0]
                const list = input && ts.isObjectLiteralExpression(input) ? property(input, 'tests') : undefined
                return list && ts.isArrayLiteralExpression(list) ? list.elements.map((element) => element.getText()) : []
            }),
        )
        expect(tests.length).toBeGreaterThan(15)
        expect([...inSuites].sort()).toEqual([...tests].sort())
    })
})
