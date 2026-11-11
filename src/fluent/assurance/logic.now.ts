import '@servicenow/sdk/global'
import { Property, ScheduledScript, UiAction } from '@servicenow/sdk/core'
import { reconcileInstalledBaseAndRacks, uiCloseAudit, uiStartSiteAudit, uiStartStockroomAudit } from '../../server/entry/assurance'
import { raiseDueAttestations } from '../../server/platform/attestations'
import { CURRENT_IS_NAAS_STOCKROOM, CURRENT_IS_SITE } from '../../server/domain/fleet'
import { PROPERTY } from '../../server/domain/properties'
import { admin, assetManager, fieldTech, scanners, stockroomWorkers } from '../shared/roles.now'

// Offered on NaaS stockrooms only, those with a NaaS stockroom type: one with none is the Provider IT's storeroom
// (ADR 0016).
UiAction({
    $id: Now.ID['ua_stockroom_blind_count'],
    name: 'Start blind count',
    table: 'alm_stockroom',
    actionName: 'x_daas_ham_start_blind_count',
    condition: CURRENT_IS_NAAS_STOCKROOM,
    roles: stockroomWorkers,
    form: { showButton: true },
    showUpdate: true,
    script: uiStartStockroomAudit,
})

UiAction({
    $id: Now.ID['ua_site_audit'],
    name: 'Start site audit',
    table: 'cmn_location',
    actionName: 'x_daas_ham_start_site_audit',
    condition: CURRENT_IS_SITE,
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
    roles: scanners,
    form: { showButton: true, style: 'primary' },
    showUpdate: true,
    script: uiCloseAudit,
})

ScheduledScript({
    $id: Now.ID['job_reconcile_installed_base'],
    name: 'NaaS - reconcile installed base',
    active: true,
    frequency: 'daily',
    executionTime: { hours: 2, minutes: 5, seconds: 0 },
    timeZone: 'UTC',
    script: reconcileInstalledBaseAndRacks,
})

Property({
    $id: Now.ID['prop_unseen_days'],
    name: PROPERTY.unseenDays.name,
    type: 'integer',
    value: PROPERTY.unseenDays.default,
    description: 'Days without a Seen signal before a deployed asset is reported as unseen.',
    roles: { read: [admin], write: [admin] },
})

ScheduledScript({
    $id: Now.ID['job_raise_attestations'],
    name: 'NaaS - raise attestations',
    active: true,
    frequency: 'daily',
    executionTime: { hours: 6, minutes: 10, seconds: 0 },
    timeZone: 'UTC',
    script: raiseDueAttestations,
})
