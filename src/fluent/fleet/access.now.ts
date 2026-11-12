import '@servicenow/sdk/global'
import { Acl } from '@servicenow/sdk/core'
import { CUSTOMER_CONTACTS } from '../../server/domain/roles'
import { deletesAsset, grantsFleetAsset, readsAssetCost, writesAsset, writesAssetCommercialField } from '../../server/entry/visibility'
import { admin, assetManager, providerStaff } from '../shared/roles.now'

/*
 * Hardware is shared with the Provider's IT (ADR 0016), and the app's read ACLs for it sit on alm_asset, its parent
 * (ADR 0005). The platform has no record read ACL on alm_hardware (the CRM Base Entities "alm_hardware" read ACL is a
 * UI page ACL), so an ACL of the app's there would be the only one on hardware and take it away from every user
 * without a NaaS role, as the app's ACLs did when they sat there. On alm_asset they are ORed with the platform's
 * (Asset Management's for internal users, Customer Service's for contacts), and alm_hardware, having none, inherits
 * both. They apply to hardware (Applies To) and grant only fleet assets (entry/visibility `grantsFleetAsset`, which
 * also keeps an inventory tech to their stockrooms and a Customer contact to their Customer and Sites); who may not
 * read a fleet asset is the Deny-Unless row check's to say (shared/visibility.now.ts). The keys are those of the ACLs
 * that sat on alm_hardware, so an install moves those records rather than leaving them there.
 */
Acl({
    $id: Now.ID['acl_alm_hardware_read_staff'],
    type: 'record',
    table: 'alm_asset',
    operation: 'read',
    roles: providerStaff,
    appliesTo: 'sys_class_name=alm_hardware',
    description: 'NaaS provider staff read fleet assets (inventory techs: those of their stockrooms).',
    script: grantsFleetAsset,
})

Acl({
    $id: Now.ID['acl_alm_hardware_read_customer'],
    type: 'record',
    table: 'alm_asset',
    operation: 'read',
    roles: CUSTOMER_CONTACTS,
    appliesTo: 'sys_class_name=alm_hardware',
    description: "NaaS Customer contacts read their Customer's fleet assets (site contacts: at the Sites listing them).",
    script: grantsFleetAsset,
})

/*
 * Changes to hardware by hand, and the hardware fields that are the Provider's own (ADR 0005, ADR 0016). Hardware is
 * shared with the Provider's IT, and the platform's `asset` role, which inventory and field techs hold, passes its ACLs
 * on alm_asset for every Asset: save it, delete it and change its company and cost, from a form, a list (an alm_asset
 * list too) or the Table API. The app's own logic saves through GlideRecord, which no ACL checks, so these ACLs bind
 * only what people do by hand.
 *
 * - On the platform's tables and fields (alm_asset, and its company and cost), Deny-Unless ACLs on alm_asset sit beside
 *   the platform's Allow-If ones at the same level, as the read row check does (shared/visibility.now.ts), and apply to
 *   hardware (Applies To) so an alm_asset list is checked too; their scripts (entry/visibility) check the class again
 *   and pass every Asset outside the fleet, which the platform's ACLs decide alone. On a fleet asset an asset editor
 *   whose scope keeps it saves it (an inventory tech: their stockrooms), an app administrator deletes it, an asset
 *   manager changes its company and cost, and a Customer contact does not read its cost (domain/visibility).
 * - The cost field has no write ACL of the platform's own: it takes alm_asset.*'s (snc_internal, not consumed). The
 *   Allow-If beside its Deny-Unless repeats that one, so the field's verdict never depends on how the platform matches a
 *   Deny-Unless ACL that has no Allow-If at its own level.
 * - The app's own columns on hardware are the app's to decide on every row, with Allow-If ACLs of their own, the most
 *   specific there: the Provider's figures and links (the support cost, the claim code that claims the unit into a
 *   vendor cloud, and the lease) are read by provider staff only, never by a Customer contact, and the Customer and
 *   ownership links (Agreement, subscription line, lease, Legal owner) are changed by hand by asset managers only. An
 *   Asset's Lessor is its lease's Vendor (ADR 0018), read and changed with the lease. The Fleet flag is set by the
 *   app's intake paths and Add to fleet (ADR 0016) and by an administrator.
 */

Acl({
    $id: Now.ID['acl_alm_asset_write_scope'],
    type: 'record',
    table: 'alm_asset',
    operation: 'write',
    decisionType: 'deny',
    appliesTo: 'sys_class_name=alm_hardware',
    description: 'NaaS: a fleet asset is saved by hand only by an asset editor who sees it (an inventory tech: their stockrooms).',
    script: writesAsset,
})

Acl({
    $id: Now.ID['acl_alm_asset_delete_scope'],
    type: 'record',
    table: 'alm_asset',
    operation: 'delete',
    decisionType: 'deny',
    appliesTo: 'sys_class_name=alm_hardware',
    description: 'NaaS: a fleet asset leaves by disposal and keeps its record; only an app administrator deletes one.',
    script: deletesAsset,
})

Acl({
    $id: Now.ID['acl_alm_asset_company_write_scope'],
    type: 'record',
    table: 'alm_asset',
    field: 'company',
    operation: 'write',
    decisionType: 'deny',
    appliesTo: 'sys_class_name=alm_hardware',
    description: "NaaS: a fleet asset's Customer (company) is changed by hand only by an asset manager.",
    script: writesAssetCommercialField,
})

Acl({
    $id: Now.ID['acl_alm_asset_cost_write_scope'],
    type: 'record',
    table: 'alm_asset',
    field: 'cost',
    operation: 'write',
    decisionType: 'deny',
    appliesTo: 'sys_class_name=alm_hardware',
    description: "NaaS: a fleet asset's cost is changed by hand only by an asset manager.",
    script: writesAssetCommercialField,
})

Acl({
    $id: Now.ID['acl_alm_asset_cost_write'],
    type: 'record',
    table: 'alm_asset',
    field: 'cost',
    operation: 'write',
    roles: ['snc_internal'],
    condition: 'install_status!=10',
    appliesTo: 'sys_class_name=alm_hardware',
    description: "NaaS: the platform's alm_asset.* write rule (internal users, not consumed), repeated beside the cost check.",
})

Acl({
    $id: Now.ID['acl_alm_asset_cost_read_scope'],
    type: 'record',
    table: 'alm_asset',
    field: 'cost',
    operation: 'read',
    decisionType: 'deny',
    appliesTo: 'sys_class_name=alm_hardware',
    description: "NaaS: a fleet asset's cost is the Provider's; Customer contacts do not read it.",
    script: readsAssetCost,
})

Acl({
    $id: Now.ID['acl_alm_hardware_support_cost_read'],
    type: 'record',
    table: 'alm_hardware',
    field: 'x_daas_ham_support_cost',
    operation: 'read',
    roles: providerStaff,
    description: "NaaS: the Provider's OEM support cost is read by provider staff only.",
})

Acl({
    $id: Now.ID['acl_alm_hardware_claim_code_read'],
    type: 'record',
    table: 'alm_hardware',
    field: 'x_daas_ham_claim_code',
    operation: 'read',
    roles: providerStaff,
    description: 'NaaS: the OEM claim code, which claims the unit into a vendor cloud account, is read by provider staff only.',
})

Acl({
    $id: Now.ID['acl_alm_hardware_lease_read'],
    type: 'record',
    table: 'alm_hardware',
    field: 'x_daas_ham_lease',
    operation: 'read',
    roles: providerStaff,
    description: "NaaS: the Provider's lease schedule is read by provider staff only.",
})

Acl({
    $id: Now.ID['acl_alm_hardware_agreement_write'],
    type: 'record',
    table: 'alm_hardware',
    field: 'x_daas_ham_agreement',
    operation: 'write',
    roles: [assetManager],
    description: "NaaS: an asset's Agreement is changed by hand only by an asset manager.",
})

Acl({
    $id: Now.ID['acl_alm_hardware_sub_line_write'],
    type: 'record',
    table: 'alm_hardware',
    field: 'x_daas_ham_subscription_line',
    operation: 'write',
    roles: [assetManager],
    description: "NaaS: an asset's subscription line is changed by hand only by an asset manager.",
})

Acl({
    $id: Now.ID['acl_alm_hardware_lease_write'],
    type: 'record',
    table: 'alm_hardware',
    field: 'x_daas_ham_lease',
    operation: 'write',
    roles: [assetManager],
    description: "NaaS: an asset's lease schedule is changed by hand only by an asset manager.",
})

Acl({
    $id: Now.ID['acl_alm_hardware_legal_owner_write'],
    type: 'record',
    table: 'alm_hardware',
    field: 'x_daas_ham_legal_owner',
    operation: 'write',
    roles: [assetManager],
    description: "NaaS: an asset's Legal owner is changed by hand only by an asset manager.",
})

Acl({
    $id: Now.ID['acl_alm_hardware_fleet_write'],
    type: 'record',
    table: 'alm_hardware',
    field: 'x_daas_ham_fleet',
    operation: 'write',
    roles: [admin],
    description: 'NaaS: the Fleet flag is set by the app (intake, Add to fleet); by hand only by an app administrator.',
})

Acl({
    $id: Now.ID['acl_alm_hardware_fleet_create'],
    type: 'record',
    table: 'alm_hardware',
    field: 'x_daas_ham_fleet',
    operation: 'create',
    roles: [admin],
    description: 'NaaS: a new Asset joins the fleet through the app (intake, Add to fleet); by hand only by an app administrator.',
})
