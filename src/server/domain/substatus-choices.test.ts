import { existsSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ADDED_SUBSTATUSES } from './lifecycle'

const FLUENT = new URL('../../fluent/data/substatus-choices.now.ts', import.meta.url)
const LIFECYCLE = new URL('./lifecycle.ts', import.meta.url)
const CONFIG = new URL('../../../now.config.json', import.meta.url)
/** Where now-sdk build writes the choice set of a field the app does not own. */
const BUILT = new URL('../../../dist/app/author_elective_update/sys_choice_alm_asset_substatus.xml', import.meta.url)
/** Where the build wrote each sys_choice on its own before the sys_choice_set parent existed. */
const BUILT_WITHOUT_PARENT = new URL('../../../dist/app/update/sys_choice_alm_asset_substatus.xml', import.meta.url)

const ADDED_VALUES = ADDED_SUBSTATUSES.map((s) => s.value).sort()

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

/** Trimmed from the SDK 4.14 output with legacyChoices false and a sys_choice_set parent. */
const V4_FIXTURE = `<?xml version="1.0"?>
<record_update>
  <sys_choice_v2 action="INSERT_OR_UPDATE" field="substatus" table="alm_asset" version="4" apply_defaults="true">
    <sys_choice_set action="INSERT_OR_UPDATE" apply_defaults="true">
      <sys_id>311323f3dd694811ba1b4f854b49fbe0</sys_id>
      <element>substatus</element>
      <sys_update_name>sys_choice_alm_asset_substatus</sys_update_name>
      <name>alm_asset</name>
      <sys_class_name>sys_choice_set</sys_class_name>
      <sys_name>substatus</sys_name>
    </sys_choice_set>
    <sys_choice action="delete_multiple" query="name=alm_asset^element=substatus^value=staging^language=en^dependent_value=6^NQname=alm_asset^element=substatus^value=staged^language=en^dependent_value=6"/>
    <sys_choice action="INSERT_OR_UPDATE" apply_defaults="true">
      <sys_id>89d1cc587cf64a49988b2b5283a106f6</sys_id>
      <name>alm_asset</name>
      <element>substatus</element>
      <label>Staging</label>
      <value>staging</value>
      <sequence>510</sequence>
      <dependent_value>6</dependent_value>
      <inactive>false</inactive>
      <language>en</language>
    </sys_choice>
    <sys_choice action="INSERT_OR_UPDATE" apply_defaults="true">
      <sys_id>f096a25f3c0e4c7f8bd2e8321e54d081</sys_id>
      <name>alm_asset</name>
      <element>substatus</element>
      <label>Staged</label>
      <value>staged</value>
      <sequence>520</sequence>
      <dependent_value>6</dependent_value>
      <inactive>false</inactive>
      <language>en</language>
    </sys_choice>
  </sys_choice_v2>
</record_update>`

/** The same set in the legacy v3 format: no delete_multiple, the field's choices are replaced. */
const V3_FIXTURE = V4_FIXTURE.replace(/sys_choice_v2/g, 'sys_choice_set')
    .replace('version="4"', 'version="3"')
    .replace(/\s*<sys_choice action="delete_multiple"[^>]*\/>/, '')

const newerThanSources = (built: URL) =>
    existsSync(built) && [FLUENT, LIFECYCLE, CONFIG].every((source) => statSync(built).mtimeMs >= statSync(source).mtimeMs)

describe('substatus sys_choice records', () => {
    const fluent = readFileSync(FLUENT, 'utf8')

    it('ship every substatus the lifecycle module relies on, with its install status', () => {
        for (const { value, label, installStatus } of ADDED_SUBSTATUSES) {
            const block = fluent.split('Record(').find((chunk: string) => chunk.includes(`value: '${value}'`))
            expect(block, value).toBeDefined()
            expect(block).toContain(`label: '${label}'`)
            expect(block).toContain(`dependent_value: '${installStatus}'`)
        }
    })

    it('ship nothing the lifecycle module does not know about', () => {
        const shipped = [...fluent.matchAll(/value: '([a-z_]+)'/g)].map((m) => m[1])
        expect(shipped.sort()).toEqual(ADDED_VALUES)
    })

    it('ship one sys_choice_set parent so all choices build into one update', () => {
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
    it('reads the v4 format as deleting only its own values', () => {
        const set = readChoiceSetXml(V4_FIXTURE)
        expect(set).toMatchObject({ wrapper: 'sys_choice_v2', version: '4', table: 'alm_asset', field: 'substatus' })
        expect(set.inserted).toEqual([
            { value: 'staging', label: 'Staging', dependentValue: '6' },
            { value: 'staged', label: 'Staged', dependentValue: '6' },
        ])
        expect(set.deleted).toEqual([
            { name: 'alm_asset', element: 'substatus', value: 'staging', language: 'en', dependent_value: '6' },
            { name: 'alm_asset', element: 'substatus', value: 'staged', language: 'en', dependent_value: '6' },
        ])
        expect(deletesOnlyOwnValues(set)).toBe(true)
    })

    it('reads the legacy v3 format as replacing every choice of the field', () => {
        const set = readChoiceSetXml(V3_FIXTURE)
        expect(set).toMatchObject({ wrapper: 'sys_choice_set', version: '3', deleted: [] })
        expect(set.inserted.map((c) => c.value)).toEqual(['staging', 'staged'])
        expect(deletesOnlyOwnValues(set)).toBe(false)
    })

    it('rejects a delete that would match an out-of-box value', () => {
        const set = readChoiceSetXml(V4_FIXTURE.replace('value=staged^', 'value=available^'))
        expect(deletesOnlyOwnValues(set)).toBe(false)
    })

    it.skipIf(!newerThanSources(BUILT))('holds every added value and deletes nothing else (last now-sdk build)', () => {
        const set = readChoiceSetXml(readFileSync(BUILT, 'utf8'))
        expect(set).toMatchObject({ wrapper: 'sys_choice_v2', version: '4', table: 'alm_asset', field: 'substatus' })
        expect(set.inserted.map((c) => c.value).sort()).toEqual(ADDED_VALUES)
        for (const { value, label, installStatus } of ADDED_SUBSTATUSES) {
            expect(set.inserted, value).toContainEqual({ value, label, dependentValue: installStatus })
        }
        expect(set.deleted.map((c) => c.value).sort()).toEqual(ADDED_VALUES)
        expect(deletesOnlyOwnValues(set)).toBe(true)
        expect(existsSync(BUILT_WITHOUT_PARENT)).toBe(false)
    })
})
