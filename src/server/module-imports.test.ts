import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * Each server module is stored on the instance as a sys_module whose path ends in ".ts", and the
 * platform resolves an import by that exact path: it adds no extension. So a relative import that
 * leaves out ".ts" builds and passes every unit test, then fails on the instance with "No module
 * with path ... found in sys_module table" the first time the importing module loads.
 */

const SERVER = new URL('.', import.meta.url).pathname

function moduleFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return moduleFiles(path)
        return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts') ? [path] : []
    })
}

/** Relative specifiers of static imports and re-exports (`from '...'`, `import '...'`). */
function relativeSpecifiers(source: string): string[] {
    return [...source.matchAll(/(?:\bfrom|^\s*import)\s+'(\.{1,2}\/[^']*)'/gm)].map((m) => m[1])
}

describe('server module imports', () => {
    it('reads the specifiers of imports and re-exports', () => {
        const source = "import { a } from './a.ts'\nimport type { B } from '../b'\nexport { c } from './c.ts'\nimport './side.ts'\nimport { gs } from '@servicenow/glide'"
        expect(relativeSpecifiers(source)).toEqual(['./a.ts', '../b', './c.ts', './side.ts'])
    })

    it('name the .ts file of every relative import, as the instance resolves them', () => {
        const missing = moduleFiles(SERVER).flatMap((file) =>
            relativeSpecifiers(readFileSync(file, 'utf8'))
                .filter((specifier) => !specifier.endsWith('.ts') && !specifier.endsWith('.json'))
                .map((specifier) => `${relative(SERVER, file)}: '${specifier}'`),
        )
        expect(missing).toEqual([])
    })
})
