import { readdirSync, readFileSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/*
 * Each server module is stored on the instance as a sys_module whose path ends in ".ts", and the
 * platform resolves an import by that exact path: it adds no extension. So a relative import that
 * leaves out ".ts" builds and passes every unit test, then fails on the instance with "No module
 * with path ... found in sys_module table" the first time the importing module loads.
 *
 * The layers (ADR 0003) import inwards only: domain/ is pure TypeScript (no platform API, nothing
 * from platform/ or entry/), so every rule in it runs under Vitest; platform/ adapts it to Glide and
 * never reaches up into entry/; entry/ wires both to the platform's entry points.
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

const LAYERS = ['domain', 'platform', 'entry'] as const
type Layer = (typeof LAYERS)[number]

/** The layers each layer may import from. */
const MAY_IMPORT: Record<Layer, readonly Layer[]> = {
    domain: ['domain'],
    platform: ['domain', 'platform'],
    entry: ['domain', 'platform', 'entry'],
}

/** The platform's APIs (`@servicenow/glide` and its sn_* namespaces) and the SDK: never imported by domain/. */
const PLATFORM_PACKAGE = /^@servicenow\//

/** The layer of a path relative to src/server (posix separators), or undefined outside the three. */
function layerOf(path: string): Layer | undefined {
    const top = path.split('/')[0]
    return LAYERS.find((layer) => layer === top)
}

/** Every specifier a module names: imports (type-only too), re-exports, import() and require(); comments and strings are skipped. */
function allSpecifiers(source: string): string[] {
    return ts.preProcessFile(source, true, true).importedFiles.map((file) => file.fileName)
}

/** Why `file` (relative to src/server, posix separators) breaks the layering with `source`: one line per import. */
function layeringViolations(file: string, source: string): string[] {
    const layer = layerOf(file)
    if (!layer) return [`${file}: not in domain/, platform/ or entry/`]
    return allSpecifiers(source).flatMap((specifier) => {
        if (!specifier.startsWith('.')) {
            return layer === 'domain' && PLATFORM_PACKAGE.test(specifier) ? [`${file}: '${specifier}' (domain imports no platform API)`] : []
        }
        const target = posix.normalize(posix.join(posix.dirname(file), specifier))
        const targetLayer = layerOf(target)
        if (targetLayer && MAY_IMPORT[layer].includes(targetLayer)) return []
        return [`${file}: '${specifier}' (${layer} may not import ${targetLayer ? `${targetLayer}/` : target})`]
    })
}

const serverPath = (file: string) => relative(SERVER, file).split(sep).join('/')

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

describe('server layering (ADR 0003)', () => {
    it('reads type-only, multi-line, re-exported, dynamic and required imports, and skips comments and strings', () => {
        const source = [
            "// import { z } from '../platform/z.ts'",
            "/* see from '@servicenow/glide' */",
            "import type { GlideRecord } from '@servicenow/glide'",
            'import {',
            '    a,',
            "} from '../platform/a.ts'",
            "export * from '../entry/b.ts'",
            "const c = require('../entry/c.ts')",
            "const d = import('./d.ts')",
            "const e = \"from '../platform/e.ts'\"",
        ].join('\n')
        expect(allSpecifiers(source)).toEqual(['@servicenow/glide', '../platform/a.ts', '../entry/b.ts', '../entry/c.ts', './d.ts'])
    })

    it('flags a domain module that imports a platform API, platform/ or entry/', () => {
        const source = "import type { GlideRecord } from '@servicenow/glide'\nimport { RESTMessageV2 } from '@servicenow/glide/sn_ws'\nimport { str } from '../../platform/records.ts'\nimport { reply } from '../../entry/x.ts'\nimport { y } from '../json.ts'"
        expect(layeringViolations('domain/oem/a.ts', source)).toEqual([
            "domain/oem/a.ts: '@servicenow/glide' (domain imports no platform API)",
            "domain/oem/a.ts: '@servicenow/glide/sn_ws' (domain imports no platform API)",
            "domain/oem/a.ts: '../../platform/records.ts' (domain may not import platform/)",
            "domain/oem/a.ts: '../../entry/x.ts' (domain may not import entry/)",
        ])
        expect(layeringViolations('domain/a.ts', "import { b } from '../platform/b.ts'\nimport { c } from '../../fluent/c.ts'")).toEqual([
            "domain/a.ts: '../platform/b.ts' (domain may not import platform/)",
            "domain/a.ts: '../../fluent/c.ts' (domain may not import ../fluent/c.ts)",
        ])
    })

    it('flags a platform module that imports entry/, and lets entry/ import every layer', () => {
        const source = "import { gs } from '@servicenow/glide'\nimport { a } from '../domain/a.ts'\nimport { b } from './b.ts'\nimport { c } from '../entry/c.ts'"
        expect(layeringViolations('platform/p.ts', source)).toEqual(["platform/p.ts: '../entry/c.ts' (platform may not import entry/)"])
        expect(layeringViolations('entry/e.ts', source)).toEqual([])
    })

    it('flags a module outside the three layers', () => {
        expect(layeringViolations('helpers/h.ts', '')).toEqual(['helpers/h.ts: not in domain/, platform/ or entry/'])
    })

    it('hold for every server module', () => {
        const files = moduleFiles(SERVER)
        expect(files.length).toBeGreaterThan(50)
        expect(files.flatMap((file) => layeringViolations(serverPath(file), readFileSync(file, 'utf8')))).toEqual([])
    })
})
