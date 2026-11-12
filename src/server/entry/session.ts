import { gs } from '@servicenow/glide'
import type { RESTAPIRequest, RESTAPIResponse } from '@servicenow/glide/sn_ws_int'
import type { SessionRoles } from '../domain/rest-contracts.ts'
import { ROLE } from '../domain/roles.ts'
import { reply } from '../platform/rest-api.ts'

/** GET /me: the app's roles the caller holds, so the workspace page offers only the lists their roles read. */
export function sessionRoles(_request: RESTAPIRequest, response: RESTAPIResponse): void {
    reply(response, 200, { roles: Object.values(ROLE).filter((role) => gs.hasRole(role)) } satisfies SessionRoles)
}
