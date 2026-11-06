import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ADDED_SUBSTATUSES } from './lifecycle'

describe('substatus sys_choice records', () => {
    const fluent = readFileSync(new URL('../../fluent/data/substatus-choices.now.ts', import.meta.url), 'utf8')

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
        expect(shipped.sort()).toEqual(ADDED_SUBSTATUSES.map((s) => s.value).sort())
    })
})
