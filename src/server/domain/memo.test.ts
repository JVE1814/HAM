import { describe, expect, it } from 'vitest'
import { memoized } from './memo'

describe('memoized', () => {
    it('reads each key once, including falsy results', () => {
        const reads: string[] = []
        const lookup = memoized((key) => {
            reads.push(key)
            return key === 'none' ? null : key.length
        })
        expect([lookup('ab'), lookup('ab'), lookup('none'), lookup('none')]).toEqual([2, 2, null, null])
        expect(reads).toEqual(['ab', 'none'])
    })
})
