import '@servicenow/sdk/global'
import { Acl } from '@servicenow/sdk/core'
import { readsRecord } from '../../server/entry/visibility'

/*
 * Row checks behind the before-query rules that narrow an inventory tech to their stockrooms (ADR 0005), one for each
 * table the rules narrow (those whose entry in domain/visibility SCOPED_TABLES names a Stockroom). A rule can only
 * append conditions, and a condition appended after an `^NQ` binds to the last clause only, so a list query with
 * `^NQ`, or a direct link, can reach a record the rule would hide. Each ACL here denies such a record: the one script
 * (entry/visibility `readsRecord`) decides on the same entry as the table's rule and keeps exactly what the rule keeps,
 * on every record of the table. So it passes every user the rule does not narrow (staff who see every Customer, and
 * users with no NaaS role, who are left to the platform), passes an inventory tech the shared tables' records outside
 * NaaS, re-checks a Customer contact's Customer and Site, and passes a record that is not a saved row (a New form, a
 * check of the whole table).
 *
 * Deny-Unless, not Allow-If: Allow-If ACLs of one name are ORed, so a row condition on one is undone by any other that
 * grants the reader, and the platform's read ACLs on alm_asset, alm_stockroom and alm_transfer_order grant an inventory
 * tech (snc_internal, asset, inventory_user) every row. Every Deny-Unless ACL that applies must pass before an Allow-If
 * one grants.
 *
 * Hardware's sits on alm_asset, beside the platform's own read ACLs there (see acls.now.ts): alm_hardware has no ACL of
 * the app's and inherits it, and an alm_asset list, which the alm_hardware rule does not narrow, is checked as well.
 * Its Applies To keeps the script off the other classes of Asset, which the script passes all the same. The shared
 * tables' row checks have no Applies To: whether a record is left to the platform depends on the reader (an inventory
 * tech's, not a Customer contact's), which Applies To cannot tell.
 */

Acl({
    $id: Now.ID['acl_alm_asset_read_scope'],
    type: 'record',
    table: 'alm_asset',
    operation: 'read',
    decisionType: 'deny',
    appliesTo: 'sys_class_name=alm_hardware',
    description: "NaaS row check: an inventory tech reads a fleet asset only of their stockrooms; a Customer contact hardware only of their Customer.",
    script: readsRecord,
})

Acl({
    $id: Now.ID['acl_alm_stockroom_read_scope'],
    type: 'record',
    table: 'alm_stockroom',
    operation: 'read',
    decisionType: 'deny',
    description: 'NaaS row check: an inventory tech reads a NaaS stockroom only when they are a member of it.',
    script: readsRecord,
})

Acl({
    $id: Now.ID['acl_alm_transfer_order_read_scope'],
    type: 'record',
    table: 'alm_transfer_order',
    operation: 'read',
    decisionType: 'deny',
    description: 'NaaS row check: an inventory tech reads a transfer order touching a NaaS stockroom only from or to one of theirs.',
    script: readsRecord,
})

Acl({
    $id: Now.ID['acl_staging_task_read_scope'],
    type: 'record',
    table: 'x_daas_ham_staging_task',
    operation: 'read',
    decisionType: 'deny',
    description: "NaaS row check: an inventory tech reads a staging task only when its asset is in one of their stockrooms.",
    script: readsRecord,
})

Acl({
    $id: Now.ID['acl_audit_read_scope'],
    type: 'record',
    table: 'x_daas_ham_audit',
    operation: 'read',
    decisionType: 'deny',
    description: 'NaaS row check: an inventory tech reads the blind counts of their stockrooms only (a site audit has none).',
    script: readsRecord,
})

Acl({
    $id: Now.ID['acl_audit_line_read_scope'],
    type: 'record',
    table: 'x_daas_ham_audit_line',
    operation: 'read',
    decisionType: 'deny',
    description: "NaaS row check: an inventory tech reads an audit line only of their stockrooms' blind counts.",
    script: readsRecord,
})
