import type { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { afterReturnProduced } from './returns.ts'
import { platform, recordOf } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

beforeEach(() => platform.reset())

describe('afterReturnProduced', () => {
    it('does nothing for a Return order that is not stored: a rule refused its insert and said why', () => {
        afterReturnProduced({ assets: 'a1' }, recordOf<GlideRecord>('x_daas_ham_return_order', { sys_id: 'ret9', customer: 'other', site: 'site9' }))
        expect(platform.messages).toEqual([])
        expect(platform.logs).toEqual([])
    })
})
