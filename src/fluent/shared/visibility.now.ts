import '@servicenow/sdk/global'
import { Acl, BusinessRule } from '@servicenow/sdk/core'
import { readsRecord, scopeRecords } from '../../server/entry/visibility'

/*
 * Every rule runs the one script, which finds the scoping of the table queried in domain/visibility SCOPED_TABLES: a
 * table is scoped by a rule here and its entry there.
 */

BusinessRule({
    $id: Now.ID['br_scope_alm_hardware'],
    name: 'NaaS - scope assets',
    table: 'alm_hardware',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeRecords,
})

BusinessRule({
    $id: Now.ID['br_scope_alm_stockroom'],
    name: 'NaaS - scope stockrooms',
    table: 'alm_stockroom',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeRecords,
})

BusinessRule({
    $id: Now.ID['br_scope_alm_transfer_order'],
    name: 'NaaS - scope transfer orders',
    table: 'alm_transfer_order',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeRecords,
})

BusinessRule({
    $id: Now.ID['br_scope_staging_task'],
    name: 'NaaS - scope staging tasks',
    table: 'x_daas_ham_staging_task',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeRecords,
})

BusinessRule({
    $id: Now.ID['br_scope_audit'],
    name: 'NaaS - scope audits',
    table: 'x_daas_ham_audit',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeRecords,
})

BusinessRule({
    $id: Now.ID['br_scope_audit_line'],
    name: 'NaaS - scope audit lines',
    table: 'x_daas_ham_audit_line',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeRecords,
})

BusinessRule({
    $id: Now.ID['br_scope_order'],
    name: 'NaaS - scope orders',
    table: 'x_daas_ham_order',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeRecords,
})

BusinessRule({
    $id: Now.ID['br_scope_order_line'],
    name: 'NaaS - scope order lines',
    table: 'x_daas_ham_order_line',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeRecords,
})

BusinessRule({
    $id: Now.ID['br_scope_agreement'],
    name: 'NaaS - scope agreements',
    table: 'x_daas_ham_agreement',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeRecords,
})

BusinessRule({
    $id: Now.ID['br_scope_subscription_line'],
    name: 'NaaS - scope subscription lines',
    table: 'x_daas_ham_subscription_line',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeRecords,
})

BusinessRule({
    $id: Now.ID['br_scope_catalog_entry'],
    name: 'NaaS - scope catalog entries',
    table: 'x_daas_ham_catalog_entry',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeRecords,
})

BusinessRule({
    $id: Now.ID['br_scope_return_order'],
    name: 'NaaS - scope return orders',
    table: 'x_daas_ham_return_order',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeRecords,
})

BusinessRule({
    $id: Now.ID['br_scope_shipment'],
    name: 'NaaS - scope shipments',
    table: 'x_daas_ham_shipment',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeRecords,
})

BusinessRule({
    $id: Now.ID['br_scope_attestation'],
    name: 'NaaS - scope attestations',
    table: 'x_daas_ham_attestation',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeRecords,
})

BusinessRule({
    $id: Now.ID['br_scope_fee_event'],
    name: 'NaaS - scope fee events',
    table: 'x_daas_ham_fee_event',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeRecords,
})

/*
 * Row checks behind the before-query rules that narrow an inventory tech to their stockrooms (ADR 0005), one for each
 * table the rules narrow (those whose entry in domain/visibility SCOPED_TABLES names a Stockroom). A rule can only
 * append conditions, and a condition appended after an `^NQ` binds to the last clause only, so a list query with
 * `^NQ`, or a direct link, can reach a record the rule would hide. Each ACL here denies such a record: the one script
 * decides on the same entry as the table's rule and keeps exactly what the rule keeps,
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
 * Hardware's sits on alm_asset, beside the platform's own read ACLs there (see fleet/access.now.ts): alm_hardware has
 * no ACL of the app's and inherits it, and an alm_asset list, which the alm_hardware rule does not narrow, is checked
 * as well. Its Applies To keeps the script off the other classes of Asset, which the script passes all the same. The
 * shared tables' row checks have no Applies To: whether a record is left to the platform depends on the reader (an
 * inventory tech's, not a Customer contact's), which Applies To cannot tell.
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
