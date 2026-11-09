import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * The SDK's generated wrapper calls a module entry point with its own parameter names
 * (e.g. `sourceOrder(event, current)`), so they must be the globals the platform provides.
 */
const PLATFORM_GLOBALS = new Set(['current', 'previous', 'event', 'producer', 'request', 'response', 'cat_item'])
const root = new URL('../../', import.meta.url).pathname

function files(dir: string, suffix: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        return statSync(path).isDirectory() ? files(path, suffix) : path.endsWith(suffix) ? [path] : []
    })
}

function entryPointsUsedByFluent(): string[] {
    const names = new Set<string>()
    for (const file of files(join(root, 'fluent'), '.now.ts')) {
        const source = readFileSync(file, 'utf8')
        for (const match of source.matchAll(/(?:script|postInsertScript|conditionScript):\s*([A-Za-z_]\w*)\s*[,\n}]/g)) {
            names.add(match[1])
        }
    }
    return [...names]
}

function parameterNames(name: string): string[] | undefined {
    for (const file of files(join(root, 'server'), '.ts')) {
        const match = readFileSync(file, 'utf8').match(new RegExp(`export function ${name}\\(([^)]*)\\)`))
        if (match) {
            let parameters = match[1]
            while (/<[^<>]*>/.test(parameters)) parameters = parameters.replace(/<[^<>]*>/g, '')
            return parameters
                .split(',')
                .map((p) => p.trim().split(/[:=\s]/)[0])
                .filter(Boolean)
        }
    }
    return undefined
}

describe('module entry points wired from Fluent', () => {
    const entryPoints = entryPointsUsedByFluent()

    it('exist', () => {
        expect(entryPoints.length).toBeGreaterThan(0)
        for (const name of entryPoints) expect(parameterNames(name), name).toBeDefined()
    })

    it('name their parameters after the platform globals', () => {
        for (const name of entryPoints) {
            for (const parameter of parameterNames(name) ?? []) {
                expect(PLATFORM_GLOBALS.has(parameter), `${name}(${parameter})`).toBe(true)
            }
        }
    })
})

/*
 * A business rule condition is a script the platform runs as written, in a field of at most 254 characters: a longer
 * one is cut off, never runs, and the rule never fires. A condition that loads a module names it by the path the SDK
 * installs it under, which carries the package name and version.
 */
const CONDITION_MAX_LENGTH = 254
const { name: packageName, version: packageVersion } = JSON.parse(readFileSync(join(root, '..', 'package.json'), 'utf8')) as {
    name: string
    version: string
}

interface BusinessRuleSource {
    rule: string
    table: string
    /** The condition script as the platform stores it; '' when the rule has none. */
    condition: string
    abortAction: boolean
    /** The module entry point the rule's script calls. */
    script?: string
}

function businessRules(): BusinessRuleSource[] {
    const found: BusinessRuleSource[] = []
    for (const file of files(join(root, 'fluent'), '.now.ts')) {
        for (const block of readFileSync(file, 'utf8').split('BusinessRule({').slice(1)) {
            const body = block.split('\n})')[0]
            const literal = body.match(/condition:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/)?.[1]
            const condition = !literal
                ? ''
                : literal.startsWith('"')
                  ? (JSON.parse(literal) as string)
                  : literal.slice(1, -1).replace(/\\(.)/g, '$1')
            found.push({
                rule: body.match(/name:\s*'([^']+)'/)?.[1] ?? file,
                table: body.match(/table:\s*'([^']+)'/)?.[1] ?? '',
                condition,
                abortAction: /abortAction:\s*true/.test(body),
                script: body.match(/script:\s*([A-Za-z_]\w*)\s*[,\n]/)?.[1],
            })
        }
    }
    return found
}

function businessRuleConditions(): Array<{ rule: string; condition: string }> {
    return businessRules().filter((rule) => rule.condition)
}

/** The body of the exported server function `name`, up to its closing brace at the start of a line. */
function functionBody(name: string): string | undefined {
    for (const file of files(join(root, 'server'), '.ts')) {
        const source = readFileSync(file, 'utf8')
        const start = source.indexOf(`export function ${name}(`)
        if (start >= 0) return source.slice(start, source.indexOf('\n}', start))
    }
    return undefined
}

describe('business rule conditions', () => {
    const conditions = businessRuleConditions()

    it('fit the condition field', () => {
        expect(conditions.length).toBeGreaterThan(0)
        for (const { rule, condition } of conditions) expect(condition.length, rule).toBeLessThanOrEqual(CONDITION_MAX_LENGTH)
    })

    it('load modules by their installed path and call what they export', () => {
        for (const { rule, condition } of conditions) {
            for (const [, path, fn] of condition.matchAll(/require\('([^']+)'\)\.(\w+)\(/g)) {
                const prefix = `x_daas_ham/${packageName}/${packageVersion}/src/`
                expect(path.startsWith(prefix), `${rule}: ${path}`).toBe(true)
                const source = readFileSync(join(root, path.slice(prefix.length)), 'utf8')
                expect(source, `${rule}: ${fn}`).toMatch(new RegExp(`export function ${fn}\\(`))
            }
        }
    })
})

/*
 * From this scope the platform ignores current.setAbortAction on a record of another scope's table (alm_hardware,
 * wm_order, sn_customerservice_case...) and writes it anyway: a before rule there refuses with its Abort action, its
 * check being the condition. A rule that aborts must have one, or it would refuse every save.
 */
describe('refusing business rules', () => {
    const rules = businessRules()

    it("refuse a save on a table of another scope with the rule's Abort action", () => {
        const elsewhere = rules.filter((rule) => !rule.table.startsWith('x_daas_ham_') && rule.script)
        expect(elsewhere.length).toBeGreaterThan(0)
        for (const { rule, script } of elsewhere) expect(functionBody(script ?? ''), `${rule}: ${script}`).not.toMatch(/setAbortAction/)
    })

    it('abort only when a condition holds', () => {
        const aborting = rules.filter((rule) => rule.abortAction)
        expect(aborting.length).toBeGreaterThan(0)
        for (const { rule, condition } of aborting) expect(condition, rule).toMatch(/require\('[^']+'\)\.\w+\(/)
    })

    // The platform runs a condition on every save of the table and action, whether or not the rule's filter matches.
    it('load their module only once a field they check changes', () => {
        for (const { rule, condition } of rules.filter((rule) => rule.condition.includes('require('))) {
            expect(condition.slice(0, condition.indexOf('require(')), rule).toMatch(/\.changes\(\)[\s\S]*&&\s*$/)
        }
    })
})
