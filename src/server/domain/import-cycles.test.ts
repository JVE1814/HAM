import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const DOMAIN = dirname(fileURLToPath(import.meta.url))

function modules(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return modules(path)
        return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
    })
}

/** The domain modules a module imports, type-only imports included: a concept two modules each need the other for has no owner. */
function imports(path: string): string[] {
    const found = readFileSync(path, 'utf8').matchAll(/^(?:import|export)\b[^'"]*?from\s+'(\.[^']+)'/gms)
    return [...found].map((match) => join(dirname(path), match[1]))
}

it('has no import cycle among the domain modules', () => {
    const graph = new Map(modules(DOMAIN).map((path) => [path, imports(path)]))
    const done = new Set<string>()
    const cycles: string[] = []
    const visit = (path: string, trail: readonly string[]): void => {
        if (trail.includes(path)) return void cycles.push([...trail.slice(trail.indexOf(path)), path].map((p) => relative(DOMAIN, p)).join(' -> '))
        if (done.has(path)) return
        for (const next of graph.get(path) ?? []) visit(next, [...trail, path])
        done.add(path)
    }
    for (const path of graph.keys()) visit(path, [])
    expect(graph.size).toBeGreaterThan(40)
    expect(cycles).toEqual([])
})
