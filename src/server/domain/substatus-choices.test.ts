import { existsSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ADDED_SUBSTATUSES, ALL_STAGES, fieldsOf, stageOf } from './lifecycle'

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

/**
 * The out-of-box alm_asset.substatus choices of a Brazil instance, as [value, install status (dependent_value)]: the
 * platform's own choice set (application Global), the first version of sys_choice_alm_asset_substatus the dev instance
 * recorded.
 * A value may sit under several install statuses; the v4 delete of each shipped choice matches its value, language and
 * install status together, so a pair is what must not collide.
 */
const OUT_OF_BOX: ReadonlyArray<readonly [string, string]> = [
    ['available', '6'], ['available', '9'], ['disposed', '7'], ['lost', '8'], ['pending_fulfillment', '1'],
    ['pending_retirement', '1'], ['reserved', '6'], ['reserved', '9'], ['sold', '7'], ['stolen', '8'], ['defective', '9'],
    ['defective', '6'], ['donated', '7'], ['end_of_support', '1'], ['pending_install', '9'], ['pending_repair', '1'],
    ['pending_repair', '6'], ['vendor_credit', '7'], ['in_repair', '1'], ['pending_disposal', '7'], ['pending_disposal', '9'],
    ['pending_donation', '9'], ['pending_donation', '6'], ['pending_install', '6'], ['is_shutdown', '1'],
    ['pending_disposal', '6'], ['pre_allocated', '9'], ['pending_transfer', '6'], ['lease_return', '7'], ['pre_allocated', '6'],
    ['pending_evaluation', '6'], ['pending_resale', '9'], ['pending_resale', '7'], ['obsolete', '7'], ['rma', '7'],
    ['buy_out', '7'], ['recalled', '7'], ['pending_resale', '6'], ['on_hold', '6'], ['legal_hold', '6'], ['quarantine', '6'],
    ['pending_return', '6'], ['pending_certificate', '6'], ['test', '6'], ['in_repair', '6'],
]

const pair = (value: string, installStatus: string) => `${value}/${installStatus}`
const OUT_OF_BOX_PAIRS = new Set(OUT_OF_BOX.map(([value, installStatus]) => pair(value, installStatus)))

type FieldValue = string | number | boolean

interface FluentRecord {
    id: string
    table: string
    data: Record<string, FieldValue>
}

/** The Record() calls of a Fluent file: each one's $id, table and the literal fields of its data. */
function readRecords(source: string): FluentRecord[] {
    return source
        .split(/\bRecord\(\{/)
        .slice(1)
        .map((chunk) => {
            const body = /\bdata:\s*\{([\s\S]*?)\}/.exec(chunk)?.[1] ?? ''
            const fields = [...body.matchAll(/(\w+):\s*(?:'([^']*)'|(-?\d+(?:\.\d+)?)|(true|false))/g)].map(
                (m): [string, FieldValue] => [m[1], m[2] ?? (m[3] !== undefined ? Number(m[3]) : m[4] === 'true')],
            )
            return {
                id: /\$id:\s*Now\.ID\['([^']+)'\]/.exec(chunk)?.[1] ?? '',
                table: /\btable:\s*'([^']+)'/.exec(chunk)?.[1] ?? '',
                data: Object.fromEntries(fields),
            }
        })
}

/*
 * What an install inserts and deletes is decided by the source alone: with "legacyChoices": false and one
 * sys_choice_set parent, the build writes one sys_choice_v2 (v4) update inserting each sys_choice record and deleting,
 * per shipped choice, only the choice with its name, element, value, language and install status (the fixtures below
 * show both formats). So these checks hold without a build; the check of the last build's output adds to them.
 */
describe('substatus sys_choice records', () => {
    const records = readRecords(readFileSync(FLUENT, 'utf8'))
    const choices = records.filter((record) => record.table === 'sys_choice')

    it('reads every Record() of the file', () => {
        expect(records).toHaveLength(ADDED_SUBSTATUSES.length + 1)
        expect(new Set(records.map((record) => record.id)).size).toBe(records.length)
        expect(records.every((record) => record.id && Object.keys(record.data).length > 0)).toBe(true)
    })

    it('ship exactly one choice per added substatus, under its install status, with every field the v4 delete keys on', () => {
        const shipped = choices.map(({ data }) => ({
            name: data.name,
            element: data.element,
            value: data.value,
            label: data.label,
            dependent_value: data.dependent_value,
            language: data.language,
            inactive: data.inactive,
        }))
        const expected = ADDED_SUBSTATUSES.map(({ value, label, installStatus }) => ({
            name: 'alm_asset',
            element: 'substatus',
            value,
            label,
            dependent_value: installStatus,
            language: 'en',
            inactive: false,
        }))
        const byValue = (a: { value: unknown }, b: { value: unknown }) => String(a.value).localeCompare(String(b.value))
        expect(shipped.sort(byValue)).toEqual(expected.sort(byValue))
        expect(ADDED_VALUES).toEqual([...new Set(ADDED_VALUES)])
    })

    it('ship no out-of-box choice, so the install deletes and re-inserts only its own', () => {
        const collisions = choices.filter(({ data }) => OUT_OF_BOX_PAIRS.has(pair(String(data.value), String(data.dependent_value))))
        expect(collisions.map(({ data }) => data.value)).toEqual([])
    })

    it('give each added choice its own place in the list, after the out-of-box ones', () => {
        const sequences = choices.map(({ data }) => data.sequence)
        expect(sequences.every((sequence) => typeof sequence === 'number' && sequence >= 500)).toBe(true)
        expect(new Set(sequences).size).toBe(sequences.length)
    })

    it('leave no stage the lifecycle stores without its choice once installed', () => {
        const added = new Set(ADDED_SUBSTATUSES.map(({ value, installStatus }) => pair(value, installStatus)))
        const missing = ALL_STAGES.map(fieldsOf)
            .filter(({ substatus }) => substatus)
            .map(({ substatus, installStatus }) => pair(substatus ?? '', installStatus))
            .filter((stored) => !added.has(stored) && !OUT_OF_BOX_PAIRS.has(stored))
        expect(missing).toEqual([])
        // In transfer is also stored as In transit / Reserved, by Inventory: an out-of-box choice.
        expect(stageOf({ installStatus: '9', substatus: 'reserved' })).toBe('in_transfer')
        expect(OUT_OF_BOX_PAIRS.has(pair('reserved', '9'))).toBe(true)
    })

    it('add every substatus the lifecycle stores that the platform does not ship', () => {
        const stored = new Set(ALL_STAGES.map(fieldsOf).map(({ substatus, installStatus }) => pair(substatus ?? '', installStatus)))
        expect(ADDED_SUBSTATUSES.filter(({ value, installStatus }) => !stored.has(pair(value, installStatus)))).toEqual([])
    })

    it('ship one sys_choice_set parent so all choices build into one update', () => {
        const parents = records.filter((record) => record.table === 'sys_choice_set')
        expect(parents).toHaveLength(1)
        expect(parents[0].data).toEqual({ name: 'alm_asset', element: 'substatus' })
        expect(records.every((record) => record.table === 'sys_choice' || record.table === 'sys_choice_set')).toBe(true)
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
