import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FLEET_FIELD, NAAS_STOCKROOM_TYPES, STOCKROOM_TYPE_FIELD } from './fleet.ts'

/*
 * The app's rules and actions on the shared tables act on fleet assets and NaaS stockrooms only (ADR 0016). Their
 * conditions are scripts the Fluent metadata spells out as literals, which this checks against domain/fleet's names.
 */

const fluent = new URL('../../fluent/', import.meta.url).pathname

function nowFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        return statSync(path).isDirectory() ? nowFiles(path) : path.endsWith('.now.ts') ? [path] : []
    })
}

/** A string literal's value, single- or double-quoted, as the platform stores it. */
function literal(source: string, key: string): string | undefined {
    const value = source.match(new RegExp(`\\b${key}:\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`))?.[1]
    if (value === undefined) return undefined
    return value.startsWith('"') ? (JSON.parse(value) as string) : value.slice(1, -1).replace(/\\(.)/g, '$1')
}

interface Metadata {
    id: string
    table: string
    action: string
    condition: string
}

/** Each `kind({ ... })` call in the Fluent files (BusinessRule, UiAction), with its id, table, actions and condition. */
function metadata(kind: string): Metadata[] {
    return nowFiles(fluent).flatMap((file) =>
        readFileSync(file, 'utf8')
            .split(`${kind}({`)
            .slice(1)
            .map((block) => {
                const body = block.split('\n})')[0] ?? ''
                return {
                    id: body.match(/\$id: Now\.ID\['([^']+)'\]/)?.[1] ?? file,
                    table: literal(body, 'table') ?? '',
                    action: body.match(/\baction:\s*(\[[^\]]*\])/)?.[1] ?? '',
                    condition: literal(body, 'condition') ?? '',
                }
            }),
    )
}

const rules = metadata('BusinessRule')
const rule = (id: string): Metadata => rules.find((found) => found.id === id) ?? { id, table: '', action: '', condition: '' }

/** The terms a condition ANDs at its top level, outside parentheses and string literals, without spaces. */
function andTerms(condition: string): string[] {
    const terms: string[] = []
    let depth = 0
    let quote = ''
    let term = ''
    for (let i = 0; i < condition.length; i++) {
        const char = condition[i] ?? ''
        if (quote) {
            if (char === quote) quote = ''
        } else if (char === "'" || char === '"') quote = char
        else if (char === '(') depth++
        else if (char === ')') depth--
        else if (depth === 0 && condition.startsWith('&&', i)) {
            terms.push(term)
            term = ''
            i++
            continue
        }
        term += char
    }
    return [...terms, term].map((found) => found.replace(/\s+/g, ''))
}

const FLEET_TEST = `current.${FLEET_FIELD}==true`

describe("the app's business rules on alm_hardware", () => {
    const onSaves = rules.filter((found) => found.table === 'alm_hardware' && !found.action.includes("'query'"))

    it('are all found', () => {
        expect(onSaves.map((found) => found.id)).toEqual(
            expect.arrayContaining(['br_asset_lease', 'br_rack_placement', 'br_rack_placement_model', 'br_rack_recheck', 'br_asset_enforce_lifecycle']),
        )
    })

    it('test the Fleet flag right after their change test, before anything else they check or load', () => {
        for (const { id, condition } of onSaves) {
            const [change, fleet] = andTerms(condition)
            expect({ id, change: /\.changes\(\)/.test(change ?? '') }).toEqual({ id, change: true })
            expect({ id, fleet }).toEqual({ id, fleet: FLEET_TEST })
        }
    })

    it('make a leased unit the Lessor’s when its lease is set or when it joins the fleet with one', () => {
        const lease = rule('br_asset_lease')
        expect(lease.action).toBe("['insert', 'update']")
        const [change, fleet, leaseSet] = andTerms(lease.condition)
        expect(change).toBe(`(current.x_daas_ham_lease.changes()||current.${FLEET_FIELD}.changes())`)
        expect(fleet).toBe(FLEET_TEST)
        expect(leaseSet).toBe("current.x_daas_ham_lease!=''")
    })

    it('check a rack placement once a save: a new Model or joining the fleet on its own, the placement with either', () => {
        const placement = rule('br_rack_placement')
        const kept = rule('br_rack_placement_model')
        const [placementChange] = andTerms(placement.condition)
        expect(placementChange).not.toContain('current.model.changes()')
        expect(placementChange).not.toContain(`current.${FLEET_FIELD}.changes()`)
        expect(placement.condition).toContain('.refusesRackPlacement(current,previous)')
        // An insert with a rack sets the placement, so only an update gives a placed Asset a new Model, or the fleet
        // flag ("Add to fleet" saves the form, then the flag alone), without setting the placement; the module leaves
        // an update that also sets it to the rule above.
        expect(kept.action).toBe("['update']")
        const [keptChange, fleet, racked] = andTerms(kept.condition)
        expect(keptChange).toBe(`(current.model.changes()||current.${FLEET_FIELD}.changes())`)
        expect(fleet).toBe(FLEET_TEST)
        expect(racked).toBe("current.x_daas_ham_rack!=''")
        expect(kept.condition).toMatch(/\.refusesKeptPlacement\(current, previous\)$/)
    })

    it('re-check a rack once a save that a before rule checked is written', () => {
        const [change, fleet] = andTerms(rule('br_rack_recheck').condition)
        expect(change).toBe(
            '(current.x_daas_ham_rack.changes()||current.x_daas_ham_ru_start.changes()||current.x_daas_ham_rack_face.changes()' +
                `||((current.model.changes()||current.${FLEET_FIELD}.changes())&&current.x_daas_ham_rack!=''))`,
        )
        expect(fleet).toBe(FLEET_TEST)
    })
})

describe('Start blind count', () => {
    it('is offered on NaaS stockrooms only: those of a NaaS stockroom type', () => {
        const [action] = metadata('UiAction').filter((found) => found.id === 'ua_stockroom_blind_count')
        expect(action?.table).toBe('alm_stockroom')
        expect(action?.condition).toBe(NAAS_STOCKROOM_TYPES.map((type) => `current.${STOCKROOM_TYPE_FIELD} == '${type}'`).join(' || '))
    })
})

describe('andTerms', () => {
    it('splits at the top level only, outside parentheses and string literals', () => {
        expect(andTerms("(a.changes() || b.changes()) && c == true && d != '&&' && f(x && y)")).toEqual([
            '(a.changes()||b.changes())',
            'c==true',
            "d!='&&'",
            'f(x&&y)',
        ])
    })
})
