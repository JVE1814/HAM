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
