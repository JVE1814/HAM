import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/*
 * The platform serves a custom scoped app's workspace under x/<vendor>/<path> and names its route ACLs
 * x.<vendor>.<path>.<route>, the vendor being the second part of the scope (x_daas_ham: daas). The SDK's
 * workspace guide says now/<path>: a now/ link is "Page not found", and a now. route ACL guards nothing.
 */

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
const scope = (JSON.parse(read('../../../now.config.json')) as { scope: string }).scope
const vendor = /^x_([a-z0-9]+)_/.exec(scope)?.[1]
const workspace = read('../../fluent/workspace/workspace.now.ts')
const path = /path: '([^']+)'/.exec(workspace)?.[1]
const landingPath = /landingPath: '([^']+)'/.exec(workspace)?.[1]

describe('NaaS Asset Workspace URL', () => {
    it('has a vendor prefix, a path and a landing path', () => {
        expect([vendor, path, landingPath]).toEqual(['daas', 'naas-assets', 'home'])
    })

    it("names the route ACL after the workspace's routes", () => {
        const acl = workspace.split('Acl({')[1] ?? ''
        expect(acl).toContain("type: 'ux_route'")
        expect(/name: '([^']+)'/.exec(acl)?.[1]).toBe(`x.${vendor}.${path}.*`)
    })

    it('links the navigator module to the landing page', () => {
        const module = read('../../fluent/ui/menu.now.ts').split("Now.ID['module_workspace']")[1] ?? ''
        expect(/query: '([^']+)'/.exec(module)?.[1]).toBe(`x/${vendor}/${path}/${landingPath}`)
    })
})
