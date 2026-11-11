import { queryOptions } from '@tanstack/react-query'
import type { SessionRoles } from '../../server/domain/rest-contracts'
import type { AppRole } from '../../server/domain/visibility'
import { ApiError, get } from '../api'

/** The signed-in user as a page needs them: whether they hold any of a group of the app's roles. */
export interface Session {
    holdsAny(roles: readonly AppRole[]): boolean
}

/**
 * GET /me. It decides what a page offers (a menu entry, a link to a form), never what the user reads: ACLs do that.
 * A user the route refuses (an external Customer user: it admits internal users only) holds none of the roles.
 */
export const sessionQuery = queryOptions({
    queryKey: ['session'],
    staleTime: Infinity,
    queryFn: async (): Promise<Session> => {
        const roles = await get<SessionRoles>('/me').then(
            (reply) => new Set<string>(reply.roles),
            (error: unknown) => {
                if (error instanceof ApiError && error.status === 403) return new Set<string>()
                throw error
            },
        )
        return { holdsAny: (group) => group.some((role) => roles.has(role)) }
    },
})
