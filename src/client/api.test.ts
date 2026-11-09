import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, get, path, post } from './api'

function answer(status: number, body: string): void {
    vi.stubGlobal('window', { g_ck: 'token' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })))
}

afterEach(() => vi.unstubAllGlobals())

describe('path', () => {
    it('URL-encodes each value and leaves the rest as written', () => {
        expect(path`/assets/${'SN 1/2'}`).toBe('/assets/SN%201%2F2')
        expect(path`/racks?site=${'a&b'}`).toBe('/racks?site=a%26b')
        expect(path`/audits/${'NAUD1'}/scan`).toBe('/audits/NAUD1/scan')
    })
})

describe('a call', () => {
    it("answers with the reply's result, sent under the API's base path with the session token", async () => {
        answer(200, JSON.stringify({ result: { serial: 'SN1' } }))
        expect(await post('/receive', { code: 'SN1' })).toEqual({ serial: 'SN1' })
        expect(fetch).toHaveBeenCalledWith('/api/x_daas_ham/naas/receive', {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-UserToken': 'token' },
            body: '{"code":"SN1"}',
        })
    })

    it("fails with the HTTP status and the app's error text", async () => {
        answer(403, JSON.stringify({ result: { error: 'Requires the inventory tech role' } }))
        const error = await get('/stockrooms').catch((e: unknown) => e)
        expect(error).toBeInstanceOf(ApiError)
        expect(error).toMatchObject({ status: 403, message: 'Requires the inventory tech role' })
    })

    it("fails with ServiceNow's own error, which is not under result, and with the status alone when the body is not JSON", async () => {
        answer(401, JSON.stringify({ error: { message: 'User Not Authenticated', detail: 'Required to provide Auth information' }, status: 'failure' }))
        await expect(get('/sites')).rejects.toMatchObject({ status: 401, message: 'User Not Authenticated: Required to provide Auth information' })
        answer(502, '<html>Bad gateway</html>')
        await expect(get('/sites')).rejects.toMatchObject({ status: 502, message: 'HTTP 502' })
    })
})
