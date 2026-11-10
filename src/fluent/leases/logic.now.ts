import '@servicenow/sdk/global'
import { BusinessRule, EmailNotification, Property, Record, ScheduledScript, ScriptAction, UiAction } from '@servicenow/sdk/core'
import {
    onAssetLeaseChanged,
    onReturnedLeaseEndChanged,
    refreshLeaseAssets,
    reviewLeases,
    transferLeaseAssets,
    uiApplyLeaseDecision,
} from '../../server/entry/leases'
import { CURRENT_IS_FLEET, FLEET_FIELD } from '../../server/domain/fleet'
import { LEASE_END_ACTION } from '../../server/domain/vocabulary'
import { EVENT } from '../../server/platform/events'
import { PROPERTY } from '../../server/platform/properties'
import { admin, leaseEditors } from '../shared/roles.now'

/* Leases and end-of-lease decisions (P3.23). */

// Fleet assets only (ADR 0016): the condition tests the Fleet flag right after its change test, as the header of
// fleet/logic.now.ts has it. A unit of the Provider IT's that joins the fleet with its Lease schedule already set (Add
// to fleet, a warehouse receipt) changes only its flag, so that change runs the rule too, in the save that adds it.
BusinessRule({
    $id: Now.ID['br_asset_lease'],
    name: 'NaaS - leased asset owned by the lessor',
    table: 'alm_hardware',
    when: 'before',
    action: ['insert', 'update'],
    order: 90,
    condition:
        `(current.x_daas_ham_lease.changes() || current.${FLEET_FIELD}.changes()) && ${CURRENT_IS_FLEET} && current.x_daas_ham_lease != ''`,
    script: onAssetLeaseChanged,
})

UiAction({
    $id: Now.ID['ua_lease_apply_decision'],
    name: 'Apply decision',
    table: 'x_daas_ham_lease_decision',
    actionName: 'x_daas_ham_lease_apply_decision',
    hint: 'Buy out (the Provider owns the assets), extend (the lease runs to the new end date) or return (stock to pending wipe for the lessor, deployed assets refreshed before the lease end). A lease being bought out or returned takes no further decision.',
    condition: 'current.active == true',
    roles: leaseEditors,
    form: { showButton: true, style: 'primary' },
    showUpdate: true,
    script: uiApplyLeaseDecision,
})

BusinessRule({
    $id: Now.ID['br_returned_lease_end_changed'],
    name: 'NaaS - refresh due follows lease end',
    table: 'x_daas_ham_lease_schedule',
    when: 'after',
    action: ['update'],
    order: 200,
    condition: `current.ends.changes() && current.end_action == '${LEASE_END_ACTION.return}'`,
    script: onReturnedLeaseEndChanged,
})

ScheduledScript({
    $id: Now.ID['job_review_leases'],
    name: 'NaaS - review leases',
    active: true,
    frequency: 'daily',
    executionTime: { hours: 5, minutes: 35, seconds: 0 },
    timeZone: 'UTC',
    script: reviewLeases,
})

Record({
    $id: Now.ID['event_lease_assets'],
    table: 'sysevent_register',
    data: {
        suffix: 'lease.assets',
        event_name: EVENT.leaseAssets,
        table: 'x_daas_ham_lease_schedule',
        description: 'Recompute refresh due dates of a returned lease\'s assets. parm1 = lease, parm2 = cursor.',
        priority: 200,
    },
})

ScriptAction({
    $id: Now.ID['sa_lease_assets'],
    name: 'NaaS - refresh due of a returned lease',
    eventName: EVENT.leaseAssets,
    active: true,
    script: refreshLeaseAssets,
    description: "Sets refresh due dates no later than the lease end (again when a returned lease's end moves) so automatic refresh swaps the equipment out in time.",
})

Record({
    $id: Now.ID['event_lease_buyout'],
    table: 'sysevent_register',
    data: {
        suffix: 'lease.buyout',
        event_name: EVENT.leaseBuyout,
        table: 'x_daas_ham_lease_schedule',
        description: 'Transfer a bought-out lease\'s assets to the Provider. parm1 = lease, parm2 = cursor.',
        priority: 200,
    },
})

ScriptAction({
    $id: Now.ID['sa_lease_buyout'],
    name: 'NaaS - transfer a bought-out lease',
    eventName: EVENT.leaseBuyout,
    active: true,
    script: transferLeaseAssets,
    description: 'Takes each asset off the lease, makes the Provider its legal owner and sets its cost to its share of the buyout price.',
})

Record({
    $id: Now.ID['event_lease_mismatch'],
    table: 'sysevent_register',
    data: {
        suffix: 'lease.mismatch',
        event_name: EVENT.leaseMismatch,
        table: 'x_daas_ham_lease_schedule',
        description: 'A lease ends before the agreements its deployed assets serve; parm1 = recipients.',
        priority: 200,
    },
})

EmailNotification({
    $id: Now.ID['mail_lease_mismatch'],
    table: 'x_daas_ham_lease_schedule',
    name: 'NaaS - lease ends before the service',
    description: 'Tells the asset managers that a lease ends while its equipment still serves customers.',
    active: true,
    triggerConditions: { generationType: 'event', eventName: EVENT.leaseMismatch },
    recipientDetails: { eventParm1WithRecipient: true },
    emailContent: {
        subject: 'Lease ${number} ends before the service it supports',
        messageHtml:
            '<p>Lease schedule ${number} with ${vendor} ends on ${ends}, but some of its equipment serves agreements that run longer (or have no end date).</p><p>Plan a buyout, an extension or a refresh before the lease end.</p>',
        importance: 'high',
    },
})

Property({
    $id: Now.ID['prop_lease_decision_group'],
    name: PROPERTY.leaseDecisionGroup.name,
    type: 'string',
    value: PROPERTY.leaseDecisionGroup.default,
    description: 'sys_id of the group that end-of-lease decisions are assigned to (blank = unassigned).',
    roles: { read: [admin], write: [admin] },
})
