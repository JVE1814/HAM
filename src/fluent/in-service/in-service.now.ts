import '@servicenow/sdk/global'
import {
    Acl,
    ChoiceColumn,
    DateTimeColumn,
    default_view,
    Form,
    List,
    Property,
    Record,
    ReferenceColumn,
    ScheduledScript,
    StringColumn,
    Table,
} from '@servicenow/sdk/core'
import { DEVICE_EVENT_KIND_CHOICES, DEVICE_EVENT_SOURCE_CHOICES } from '../../server/domain/vocabulary'
import { FLEET_CONDITION } from '../../server/domain/fleet'
import { purgeDeviceEvents } from '../../server/entry/in-service'
import { detectPendingInService } from '../../server/platform/in-service'
import { PROPERTY } from '../../server/domain/properties'
import { admin, assetManager, broadStaff, integration } from '../shared/roles.now'
import { naasMenu } from '../shared/menu.now'

/* In service: the Seen signals monitoring posts, the job that reads them and their settings. */

/** A Seen signal (state change only) from monitoring for one Asset. */
export const x_daas_ham_device_event = Table({
    name: 'x_daas_ham_device_event',
    label: 'Device event',
    schema: {
        asset: ReferenceColumn({ label: 'Asset', referenceTable: 'alm_hardware', referenceQual: FLEET_CONDITION }),
        identifier: StringColumn({ label: 'Identifier', maxLength: 100, mandatory: true }),
        event: ChoiceColumn({
            label: 'Event',
            choices: DEVICE_EVENT_KIND_CHOICES,
            mandatory: true,
            dropdown: 'dropdown_without_none',
        }),
        source: ChoiceColumn({
            label: 'Source',
            choices: DEVICE_EVENT_SOURCE_CHOICES,
            mandatory: true,
            default: 'nms',
            dropdown: 'dropdown_without_none',
        }),
        observed_at: DateTimeColumn({ label: 'Observed at', mandatory: true }),
    },
    index: [
        { name: 'x_daas_ham_de_asset', unique: false, element: 'asset' },
        { name: 'x_daas_ham_de_created', unique: false, element: 'sys_created_on' },
    ],
})

ScheduledScript({
    $id: Now.ID['job_in_service_detection'],
    name: 'NaaS - in-service detection',
    active: true,
    frequency: 'periodically',
    executionInterval: { minutes: 15 },
    executionStart: '2026-01-01 00:00:00',
    timeZone: 'UTC',
    script: detectPendingInService,
})

ScheduledScript({
    $id: Now.ID['job_purge_device_events'],
    name: 'NaaS - purge old device events',
    active: true,
    frequency: 'daily',
    executionTime: { hours: 3, minutes: 10, seconds: 0 },
    timeZone: 'UTC',
    script: purgeDeviceEvents,
})

Property({
    $id: Now.ID['prop_events_max_batch'],
    name: PROPERTY.eventsMaxBatch.name,
    type: 'integer',
    value: PROPERTY.eventsMaxBatch.default,
    description: 'Maximum device events accepted per REST request.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_events_retention_days'],
    name: PROPERTY.eventsRetentionDays.name,
    type: 'integer',
    value: PROPERTY.eventsRetentionDays.default,
    description: 'Days device events are kept.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_unseen_days'],
    name: PROPERTY.unseenDays.name,
    type: 'integer',
    value: PROPERTY.unseenDays.default,
    description: 'Days without a Seen signal before a deployed asset is reported as unseen.',
    roles: { read: [admin], write: [admin] },
})

Acl({
    $id: Now.ID['acl_device_event_read'],
    type: 'record',
    table: 'x_daas_ham_device_event',
    operation: 'read',
    roles: broadStaff,
})

Acl({
    $id: Now.ID['acl_device_event_create'],
    type: 'record',
    table: 'x_daas_ham_device_event',
    operation: 'create',
    roles: [integration, assetManager],
})

Acl({
    $id: Now.ID['acl_device_event_write'],
    type: 'record',
    table: 'x_daas_ham_device_event',
    operation: 'write',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_device_event_delete'],
    type: 'record',
    table: 'x_daas_ham_device_event',
    operation: 'delete',
    roles: [admin],
})

Form({
    table: 'x_daas_ham_device_event',
    view: default_view,
    sections: [
        {
            caption: 'Event',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'asset', type: 'table_field' }, { field: 'identifier', type: 'table_field' }, { field: 'event', type: 'table_field' }],
                    rightElements: [{ field: 'source', type: 'table_field' }, { field: 'observed_at', type: 'table_field' }],
                },
            ],
        },
    ],
})

List({ table: 'x_daas_ham_device_event', view: default_view, columns: ['observed_at', 'asset', 'identifier', 'event', 'source'] })

Record({
    $id: Now.ID['module_device_events'],
    table: 'sys_app_module',
    data: {
        title: 'Device events',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_device_event',
        roles: broadStaff,
        active: true,
        order: 340,
    },
})
