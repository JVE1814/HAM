import { describe, expect, it } from 'vitest'
import { assertNever, oneOf } from './exhaustive'

const FACES = ['front', 'rear'] as const

describe('oneOf', () => {
    it('gives back a value of the set', () => {
        expect(oneOf('rear', FACES)).toBe('rear')
    })

    it('gives undefined for a value outside it, a blank or a different case', () => {
        expect(oneOf('side', FACES)).toBeUndefined()
        expect(oneOf('', FACES)).toBeUndefined()
        expect(oneOf('Front', FACES)).toBeUndefined()
    })
})

describe('assertNever', () => {
    it('throws, naming the value that reached it', () => {
        expect(() => assertNever('side' as never, 'rack face')).toThrow('Unexpected rack face: side')
    })
})
