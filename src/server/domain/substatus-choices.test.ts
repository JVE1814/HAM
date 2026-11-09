import { existsSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { STAGE_FIELDS } from './vocabulary'

const FLUENT = new URL('../../fluent/data/substatus-choices.now.ts', import.meta.url)
const VOCABULARY = new URL('./vocabulary.ts', import.meta.url)
const CONFIG = new URL('../../../now.config.json', import.meta.url)
/** Where now-sdk build writes the choice set of a field the app does not own. */
const BUILT = new URL('../../../dist/app/author_elective_update/sys_choice_alm_asset_substatus.xml', import.meta.url)
/** Where the build wrote each sys_choice on its own before the sys_choice_set parent existed. */
const BUILT_WITHOUT_PARENT = new URL('../../../dist/app/update/sys_choice_alm_asset_substatus.xml', import.meta.url)

/** The substatus values the app adds: one per Lifecycle stage whose STAGE_FIELDS entry carries a `choice`. */
const ADDED = Object.values(STAGE_FIELDS).flatMap((fields) =>
    'choice' in fields ? [{ value: fields.substatus, label: fields.choice.label, dependentValue: fields.installStatus }] : [],
)
const ADDED_VALUES = ADDED.map((choice) => choice.value).sort()

interface ChoiceSetXml {
    wrapper: string
    version: string
    table: string
    field: string
    inserted: Array<{ value: string; label: string; dependentValue: string }>
    deleted: Array<{ [field: string]: string }>
}

/** Reads the parts of a built choice-set update that decide what an install inserts and deletes. */
function readChoiceSetXml(xml: string): ChoiceSetXml {
    const wrapper = /<(sys_choice_v2|sys_choice_set) action="INSERT_OR_UPDATE" field="([^"]*)" table="([^"]*)" version="(\d+)"/.exec(xml)
    const tag = (body: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1] ?? ''
    return {
        wrapper: wrapper?.[1] ?? '',
        field: wrapper?.[2] ?? '',
        table: wrapper?.[3] ?? '',
        version: wrapper?.[4] ?? '',
        inserted: [...xml.matchAll(/<sys_choice action="INSERT_OR_UPDATE"[^>]*>([\s\S]*?)<\/sys_choice>/g)].map((m) => ({
            value: tag(m[1], 'value'),
            label: tag(m[1], 'label'),
            dependentValue: tag(m[1], 'dependent_value'),
        })),
        deleted: [...xml.matchAll(/<sys_choice action="delete_multiple" query="([^"]*)"\s*\/>/g)]
            .flatMap((m) => m[1].split('^NQ'))
            .map((clause) => Object.fromEntries(clause.split('^').map((part) => part.split('=', 2)))),
    }
}

/**
 * True when installing the set can delete only values it ships itself. The v3 sys_choice_set
 * wrapper (legacyChoices true) deletes every choice of the field before inserting; the v4
 * sys_choice_v2 wrapper deletes only what its delete_multiple queries match.
 */
function deletesOnlyOwnValues(set: ChoiceSetXml): boolean {
    if (set.wrapper !== 'sys_choice_v2' || set.version !== '4') return false
    const own = new Set(set.inserted.map((c) => c.value))
    return set.deleted.every((c) => c.name === set.table && c.element === set.field && own.has(c.value))
}

const newerThanSources = (built: URL) =>
    existsSync(built) && [FLUENT, VOCABULARY, CONFIG].every((source) => statSync(built).mtimeMs >= statSync(source).mtimeMs)

describe('substatus sys_choice records', () => {
    it('ship one sys_choice_set parent so all choices build into one update', () => {
        const fluent = readFileSync(FLUENT, 'utf8')
        const parents = fluent.split('Record(').filter((chunk: string) => chunk.includes(`table: 'sys_choice_set'`))
        expect(parents).toHaveLength(1)
        expect(parents[0]).toContain(`name: 'alm_asset'`)
        expect(parents[0]).toContain(`element: 'substatus'`)
        expect(parents[0]).not.toContain('value:')
    })

    it('build choice sets in the additive v4 format, which the parent requires', () => {
        const config = JSON.parse(readFileSync(CONFIG, 'utf8')) as { legacyChoices?: boolean }
        expect(config.legacyChoices).toBe(false)
    })
})

describe('built substatus choice set', () => {
    it.skipIf(!newerThanSources(BUILT))('holds every substatus the app adds and deletes nothing else (last now-sdk build)', () => {
        const set = readChoiceSetXml(readFileSync(BUILT, 'utf8'))
        expect(set).toMatchObject({ wrapper: 'sys_choice_v2', version: '4', table: 'alm_asset', field: 'substatus' })
        expect(set.inserted.map((c) => c.value).sort()).toEqual(ADDED_VALUES)
        for (const choice of ADDED) expect(set.inserted, choice.value).toContainEqual(choice)
        expect(set.deleted.map((c) => c.value).sort()).toEqual(ADDED_VALUES)
        expect(deletesOnlyOwnValues(set)).toBe(true)
        expect(existsSync(BUILT_WITHOUT_PARENT)).toBe(false)
    })
})
