import { describe, expect, it } from 'vitest'
import { andEachClause } from './encoded-query'

describe('andEachClause', () => {
    it('repeats the condition in every OR group', () => {
        expect(andEachClause('install_status=1^NQinstall_status=6', 'sys_id>abc')).toBe('install_status=1^sys_id>abc^NQinstall_status=6^sys_id>abc')
    })

    it('appends to a single-group query and stands alone on an empty one', () => {
        expect(andEachClause('active=true', 'sys_id>abc')).toBe('active=true^sys_id>abc')
        expect(andEachClause('', 'sys_id>abc')).toBe('sys_id>abc')
    })
})
