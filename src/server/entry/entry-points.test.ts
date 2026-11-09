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

function businessRuleConditions(): Array<{ rule: string; condition: string }> {
    const found: Array<{ rule: string; condition: string }> = []
    for (const file of files(join(root, 'fluent'), '.now.ts')) {
        for (const block of readFileSync(file, 'utf8').split('BusinessRule({').slice(1)) {
            const body = block.split('\n})')[0]
            const literal = body.match(/condition:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/)?.[1]
            if (!literal) continue
            const condition = literal.startsWith('"') ? (JSON.parse(literal) as string) : literal.slice(1, -1).replace(/\\(.)/g, '$1')
            found.push({ rule: body.match(/name:\s*'([^']+)'/)?.[1] ?? file, condition })
        }
    }
    return found
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
