import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROLE } from '../../server/domain/roles'
import { ApiError } from '../api'
import { sessionQuery } from './session'

function answer(status: number, body: object): void {
    vi.stubGlobal('window', { g_ck: 'token' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))
}

afterEach(() => vi.unstubAllGlobals())

describe('sessionQuery', () => {
    it('holds the roles GET /me answers with', async () => {
        answer(200, { result: { roles: [ROLE.assetManager] } })
        const session = await new QueryClient().fetchQuery(sessionQuery)
        expect(session.holdsAny([ROLE.assetManager])).toBe(true)
        expect(session.holdsAny([ROLE.finance])).toBe(false)
        expect(session.holdsAny([])).toBe(false)
        expect(fetch).toHaveBeenCalledWith('/api/x_daas_ham/naas/me', expect.anything())
    })

    it('holds no role when the route refuses the user', async () => {
        answer(403, { result: { error: 'Requires an internal user' } })
        const session = await new QueryClient().fetchQuery(sessionQuery)
        for (const role of Object.values(ROLE)) expect(session.holdsAny([role])).toBe(false)
    })

    it('fails on any other error', async () => {
        answer(500, { result: { error: 'Boom' } })
        const error = await new QueryClient().fetchQuery(sessionQuery).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(ApiError)
        expect(error).toMatchObject({ status: 500 })
    })
})
