import '@servicenow/sdk/global'
import { Acl } from '@servicenow/sdk/core'
import { customerRoles } from './roles.now'

/*
 * A route that names no ACL enforces the platform's
 * "Scripted REST External Default" (SCRIPTED_REST_EXTERNAL_DEFAULT), so it admits no customer user. The routes built
 * for customer users (the customer self-service and rack pages) list that ACL and the app's customer one
 * (`staffOrCustomer`); a user passes either one, as on the platform's own CSM case API. Those routes also turn off
 * "Requires SNC Internal role", which customer users, who hold snc_external, cannot pass. Each handler still checks
 * the caller's role and Customer.
 */

export const customerRestAcl = Acl({
    $id: Now.ID['acl_rest_customer'],
    type: 'rest_endpoint',
    name: 'x_daas_ham NaaS customer routes',
    operation: 'execute',
    roles: customerRoles,
    description: "Admits customer admins and site contacts to the NaaS API's customer, site and rack routes; the handlers check the role and the Customer.",
})

/**
 * The platform's "Scripted REST External Default" ACL (global): role snc_internal and the script
 * `answer = !gs.hasRole("snc_external")`.
 */
const SCRIPTED_REST_EXTERNAL_DEFAULT = 'cf9d01d3e73003009d6247e603f6a990'

/** A customer route's ACLs: staff pass the platform's default one, customer admins and site contacts the app's. */
export const staffOrCustomer = [SCRIPTED_REST_EXTERNAL_DEFAULT, customerRestAcl]
