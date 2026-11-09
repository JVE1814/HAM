import '@servicenow/sdk/global'
import { Acl, BusinessRule, ScheduledScript, UiAction, UiPage } from '@servicenow/sdk/core'
import { raiseAttestations, uiCloseAudit, uiStartSiteAudit, uiStartStockroomAudit } from '../../server/entry/assurance'
import { explainRackRefusal, reconcileInstalledBaseAndRacks, recheckRackPlacement } from '../../server/entry/racks'
import rackPage from '../../client/rack.html'
import { accountManager, assetManager, customerAdmin, fieldTech, finance, inventoryTech, noc, siteContact } from '../security/roles.now'

/* Audits, attestations, reconciliation and racks (P2.7–P2.8). */

// Offered on NaaS stockrooms only, those with a NaaS stockroom type (domain/fleet NAAS_STOCKROOM_TYPES): one with
// none is the Provider IT's storeroom (ADR 0016), as "Start site audit" below is offered on Sites only.
UiAction({
    $id: Now.ID['ua_stockroom_blind_count'],
    name: 'Start blind count',
    table: 'alm_stockroom',
    actionName: 'x_daas_ham_start_blind_count',
    condition:
        "current.x_daas_ham_stockroom_type == 'central_depot' || current.x_daas_ham_stockroom_type == 'staging_centre' || current.x_daas_ham_stockroom_type == 'customer_site'",
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

// alm_hardware is a global table: the platform refuses current.setAbortAction from this scope and saves anyway, so
// the rule refuses with its Abort action when the condition (the module's check) holds; the script only says why. The
// platform runs the condition on every save, whatever the rule's filter, so its change test keeps the module unloaded
// on other saves, and the Fleet flag right after it keeps the Provider IT's equipment out (ADR 0016). The condition
// field holds at most 254 characters: so this one is written without spaces, and a racked Asset's new Model or joining
// the fleet, which would not fit beside the rest, has a rule of its own below. This one checks every save that sets
// the placement (an insert with a rack, a new rack, lowest unit or face), with whatever Model the save gives the Asset
// and as new to the rack when it joins the fleet with that save, so the other leaves those saves to it: each save is
// checked, and refused, once.
BusinessRule({
    $id: Now.ID['br_rack_placement'],
    name: 'NaaS - check rack placement and power',
    table: 'alm_hardware',
    when: 'before',
    action: ['insert', 'update'],
    order: 150,
    condition:
        "(current.x_daas_ham_rack.changes()||current.x_daas_ham_ru_start.changes()||current.x_daas_ham_rack_face.changes())&&current.x_daas_ham_fleet==true&&require('x_daas_ham/naas-ham/0.1.0/src/server/entry/racks.ts').refusesRackPlacement(current,previous)",
    abortAction: true,
    script: explainRackRefusal,
})

// The same check when a racked Asset keeps its placement and gets a new Model (its height and power change) or joins
// the fleet: "Add to fleet" saves the form first, while the unit is outside the fleet and no rule checks it, then
// changes only the flag, so its placement is checked as one new to the rack (entry/racks refusesKeptPlacement). A
// save that also sets the placement is the rule above's. An update only, as an insert with a rack sets the placement.
BusinessRule({
    $id: Now.ID['br_rack_placement_model'],
    name: 'NaaS - racked asset must fit its rack',
    table: 'alm_hardware',
    when: 'before',
    action: ['update'],
    order: 150,
    condition:
        "(current.model.changes() || current.x_daas_ham_fleet.changes()) && current.x_daas_ham_fleet == true && current.x_daas_ham_rack != '' && require('x_daas_ham/naas-ham/0.1.0/src/server/entry/racks.ts').refusesKeptPlacement(current, previous)",
    abortAction: true,
    script: explainRackRefusal,
})

// The before rules check the placements saved so far; this one re-checks the racks once the save is written, for two
// saves at the same moment that both passed them, a racked unit joining the fleet among them. Written without spaces
// to fit the 254 characters.
BusinessRule({
    $id: Now.ID['br_rack_recheck'],
    name: 'NaaS - re-check rack overlaps and power',
    table: 'alm_hardware',
    when: 'after',
    action: ['insert', 'update'],
    order: 150,
    condition:
        "(current.x_daas_ham_rack.changes()||current.x_daas_ham_ru_start.changes()||current.x_daas_ham_rack_face.changes()||((current.model.changes()||current.x_daas_ham_fleet.changes())&&current.x_daas_ham_rack!=''))&&current.x_daas_ham_fleet==true",
    script: recheckRackPlacement,
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
