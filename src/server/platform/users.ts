import { ROLE } from '../domain/roles.ts'
import { pluck } from './records.ts'

/**
 * The asset managers (active users, at most 20): who decides for the Provider where no one person is named
 * (platform/approvals), and who is warned of what needs the Provider's attention.
 */
export function assetManagerIds(): string[] {
    return pluck('sys_user_has_role', `role.name=${ROLE.assetManager}^user.active=true^state=active`, 'user', 20)
}
