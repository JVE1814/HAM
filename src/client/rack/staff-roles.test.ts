import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/*
 * The rack page links a device to its Asset form only for the roles that may open it, which it lists by name: the page
 * cannot import the Fluent role records. So the list is checked here against roles.now.ts `providerStaff`, the roles
 * alm_hardware's read ACLs admit, and a role added there or renamed fails this until the page lists it too.
 */

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const roles = readFileSync(new URL('../../fluent/security/roles.now.ts', import.meta.url), 'utf8')

/** Each roles.now.ts constant's role name. */
const roleName = new Map([...roles.matchAll(/export const (\w+) = Role\(\{\s*name: '([^']+)'/g)].map((m) => [m[1], m[2]]))

describe('the rack page staff roles', () => {
    it("are roles.now.ts providerStaff, so every staff role, and only they, get a device's Asset form link", () => {
        const pageList = /const STAFF_ROLES = \[([^\]]*)\]/.exec(app)?.[1]
        const staffList = /export const providerStaff = \[([^\]]*)\]/.exec(roles)?.[1]
        expect(pageList, 'STAFF_ROLES in App.tsx').toBeDefined()
        expect(staffList, 'providerStaff in roles.now.ts').toBeDefined()
        const page = [...(pageList ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
        const staff = (staffList ?? '')
            .split(',')
            .map((name) => roleName.get(name.trim()) ?? `unknown role constant ${name.trim()}`)
            .sort()
        expect(staff).toHaveLength(6)
        expect(page).toEqual(staff)
    })
})
