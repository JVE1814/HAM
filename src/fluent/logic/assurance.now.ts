import '@servicenow/sdk/global'
import { Acl, BusinessRule, ScheduledScript, UiAction, UiPage } from '@servicenow/sdk/core'
import { raiseAttestations, reconcileInstalledBase, uiCloseAudit, uiStartSiteAudit, uiStartStockroomAudit } from '../../server/entry/assurance'
import { guardRackPlacement } from '../../server/entry/racks'
import rackPage from '../../client/rack.html'
import { accountManager, assetManager, customerAdmin, fieldTech, finance, inventoryTech, noc, siteContact } from '../security/roles.now'

/* Audits, attestations, reconciliation and racks (P2.7–P2.8). */

UiAction({
    $id: Now.ID['ua_stockroom_blind_count'],
    name: 'Start blind count',
    table: 'alm_stockroom',
    actionName: 'x_daas_ham_start_blind_count',
    roles: [inventoryTech, assetManager],
    form: { showButton: true },
    showUpdate: true,
    script: uiStartStockroomAudit,
})

UiAction({
    $id: Now.ID['ua_site_audit'],
    name: 'Start site audit',
    table: 'cmn_location',
    actionName: 'x_daas_ham_start_site_audit',
    condition: 'current.x_daas_ham_is_site == true',
    roles: [assetManager, fieldTech],
    form: { showButton: true },
    showUpdate: true,
    script: uiStartSiteAudit,
})

UiAction({
    $id: Now.ID['ua_audit_close'],
    name: 'Close audit',
    table: 'x_daas_ham_audit',
    actionName: 'x_daas_ham_close_audit',
    hint: 'Compare the scans with the expected assets; missing assets become reconciliation exceptions.',
    condition: 'current.active == true',
    roles: [inventoryTech, fieldTech, assetManager],
    form: { showButton: true, style: 'primary' },
    showUpdate: true,
    script: uiCloseAudit,
})

BusinessRule({
    $id: Now.ID['br_rack_placement'],
    name: 'NaaS - rack placement must be free and within power',
    table: 'alm_hardware',
    when: 'before',
    action: ['insert', 'update'],
    order: 150,
    condition:
        "current.x_daas_ham_rack.changes() || current.x_daas_ham_ru_start.changes() || current.x_daas_ham_rack_face.changes() || (current.model.changes() && current.x_daas_ham_rack != '')",
    script: guardRackPlacement,
})

ScheduledScript({
    $id: Now.ID['job_reconcile_installed_base'],
    name: 'NaaS - reconcile installed base',
    active: true,
    frequency: 'daily',
    executionTime: { hours: 2, minutes: 5, seconds: 0 },
    timeZone: 'UTC',
    script: reconcileInstalledBase,
})

ScheduledScript({
    $id: Now.ID['job_raise_attestations'],
    name: 'NaaS - raise attestations',
    active: true,
    frequency: 'daily',
    executionTime: { hours: 6, minutes: 10, seconds: 0 },
    timeZone: 'UTC',
    script: raiseAttestations,
})

export const rackElevationPage = UiPage({
    $id: Now.ID['page_racks'],
    endpoint: 'x_daas_ham_racks.do',
    description: 'Front and rear rack elevations per site, coloured by stage, customer or EoX / coverage risk.',
    category: 'general',
    html: rackPage,
    direct: true,
})

Acl({
    $id: Now.ID['acl_page_racks'],
    type: 'ui_page',
    name: 'x_daas_ham_racks',
    operation: 'read',
    roles: [assetManager, inventoryTech, fieldTech, noc, accountManager, finance, customerAdmin, siteContact],
})
