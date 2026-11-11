import '@servicenow/sdk/global'
import {
    Acl,
    DateTimeColumn,
    default_view,
    Form,
    IntegerColumn,
    List,
    Property,
    Record,
    ScheduledScript,
    StringColumn,
    Table,
} from '@servicenow/sdk/core'
import { LOCK_NAME_LENGTH } from '../../server/domain/lock-names'
import { runPreflight } from '../../server/entry/preflight'
import { PROPERTY } from '../../server/domain/properties'
import { DEMO_DEPOT_GROUP, loadDemoData } from '../../server/entry/demo-seed'
import { ROLE } from '../../server/domain/roles'
import { admin } from '../shared/roles.now'
import { naasMenu } from '../shared/menu.now'

/*
 * What the app's background work runs on: where each job keeps its place and its lock, the settings every job reads
 * (jobs are chunked where they touch many assets, ADR 0007), the preflight check and the demo data loader.
 */

/**
 * One row per background job, read and written only by src/server/platform/job-cursor.ts. Most are cursors (ADR 0007):
 * where a scheduled chunked job stopped, so the next run resumes there, or, for a job whose passes replace each other
 * (`margin_<period>`, `billing_generate_<period>`), the current pass's token. Two rows are not cursors and are kept
 * here under the names they have always had, so an upgrade keeps them: `provider_tag_sequence`, whose Cursor is the
 * last Provider tag number issued, and `preflight`, whose Last status is the preflight check's last result.
 */
export const x_daas_ham_job_cursor = Table({
    name: 'x_daas_ham_job_cursor',
    label: 'Job cursor',
    display: 'job',
    schema: {
        job: StringColumn({ label: 'Job', maxLength: 100, mandatory: true }),
        cursor: StringColumn({ label: 'Cursor', maxLength: 100 }),
        last_run: DateTimeColumn({ label: 'Last run' }),
        last_status: StringColumn({ label: 'Last status', maxLength: 255 }),
        processed_total: IntegerColumn({ label: 'Processed (last run)', default: 0 }),
        // A pass's records that failed so far, over all its runs, and the last error (platform/chunked `runTableJob`).
        failed_total: IntegerColumn({ label: 'Failed (this pass)', default: 0 }),
        last_error: StringColumn({ label: 'Last error', maxLength: 1000 }),
    },
    index: [{ name: 'x_daas_ham_jc_job', unique: true, element: 'job' }],
})

/** Job locks: one row per lock held, behind a unique index so that only one holder can take it (ADR 0013). */
export const x_daas_ham_job_lock = Table({
    name: 'x_daas_ham_job_lock',
    label: 'Job lock',
    display: 'name',
    // Locks are taken and released all the time; their deletes are not worth keeping in Deleted Records.
    attributes: { no_audit_delete: true },
    schema: {
        name: StringColumn({ label: 'Lock', maxLength: LOCK_NAME_LENGTH, mandatory: true }),
    },
    index: [{ name: 'x_daas_ham_jl_name', unique: true, element: 'name' }],
})

ScheduledScript({
    $id: Now.ID['job_preflight'],
    name: 'NaaS - preflight check',
    active: true,
    frequency: 'on_demand',
    script: runPreflight,
})

Property({
    $id: Now.ID['prop_job_batch_size'],
    name: PROPERTY.jobBatchSize.name,
    type: 'integer',
    value: PROPERTY.jobBatchSize.default,
    description: 'Records fetched per batch by chunked background jobs.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_job_budget_seconds'],
    name: PROPERTY.jobBudgetSeconds.name,
    type: 'integer',
    value: PROPERTY.jobBudgetSeconds.default,
    description: 'Seconds a chunked job may run before pausing; the next run resumes where it stopped.',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_provider_company'],
    name: PROPERTY.providerCompany.name,
    type: 'string',
    value: PROPERTY.providerCompany.default,
    description: "sys_id of the Provider's own core_company record (company of unassigned stock).",
    roles: { read: [admin], write: [admin] },
})

/*
 * Demo data (installMethod demo): the SDK installs it unless the app is installed with `now-sdk install --no-demoData`,
 * so install production that way (README "Install"). Run it once with "Execute Now"; it loads nothing on an instance in
 * use (entry/demo-seed `demoRefusal`).
 */

/*
 * The group the demo depots are assigned to (ADR 0018). It ships as a record because the job cannot create it:
 * sys_user_group lets other scopes read it, not create or update (Brazil instance, 2026-11-09).
 */
Record({
    $id: Now.ID['demo_depot_group'],
    $meta: { installMethod: 'demo' },
    table: 'sys_user_group',
    data: {
        name: DEMO_DEPOT_GROUP,
        description: 'Demo data: the inventory techs of the demo central depot and staging centre.',
        active: true,
    },
})

ScheduledScript({
    $id: Now.ID['job_load_demo_data'],
    $meta: { installMethod: 'demo' },
    name: 'NaaS - load demo data',
    active: true,
    frequency: 'on_demand',
    script: loadDemoData,
})

Acl({
    $id: Now.ID['acl_job_cursor_read'],
    type: 'record',
    table: 'x_daas_ham_job_cursor',
    operation: 'read',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_job_cursor_write'],
    type: 'record',
    table: 'x_daas_ham_job_cursor',
    operation: 'write',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_job_cursor_create'],
    type: 'record',
    table: 'x_daas_ham_job_cursor',
    operation: 'create',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_job_cursor_delete'],
    type: 'record',
    table: 'x_daas_ham_job_cursor',
    operation: 'delete',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_job_lock_read'],
    type: 'record',
    table: 'x_daas_ham_job_lock',
    operation: 'read',
    roles: [admin],
})

Acl({
    $id: Now.ID['acl_job_lock_delete'],
    type: 'record',
    table: 'x_daas_ham_job_lock',
    operation: 'delete',
    roles: [admin],
})

Form({
    table: 'x_daas_ham_job_cursor',
    view: default_view,
    sections: [
        {
            caption: 'Job',
            content: [
                {
                    layout: 'two-column',
                    leftElements: [{ field: 'job', type: 'table_field' }, { field: 'cursor', type: 'table_field' }],
                    rightElements: [{ field: 'last_run', type: 'table_field' }, { field: 'last_status', type: 'table_field' }, { field: 'processed_total', type: 'table_field' }, { field: 'failed_total', type: 'table_field' }, { field: 'last_error', type: 'table_field' }],
                },
            ],
        },
    ],
})

List({ table: 'x_daas_ham_job_cursor', view: default_view, columns: ['job', 'cursor', 'last_run', 'last_status', 'processed_total', 'failed_total', 'last_error'] })

Record({
    $id: Now.ID['module_load_data'],
    table: 'sys_app_module',
    data: {
        title: 'Load data',
        application: naasMenu,
        link_type: 'DIRECT',
        query: 'sys_import.do',
        // Loading an import set takes the platform's import_set_loader role (import_admin contains it), which no NaaS
        // role contains: offered to those who hold it.
        roles: ['import_set_loader'],
        active: true,
        order: 630,
    },
})

Record({
    $id: Now.ID['module_properties'],
    table: 'sys_app_module',
    data: {
        title: 'Properties',
        application: naasMenu,
        link_type: 'FILTER',
        name: 'sys_properties',
        filter: 'nameSTARTSWITHx_daas_ham.',
        roles: [ROLE.admin],
        active: true,
        order: 910,
    },
})

Record({
    $id: Now.ID['module_job_cursors'],
    table: 'sys_app_module',
    data: {
        title: 'Background jobs',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_job_cursor',
        roles: [ROLE.admin],
        active: true,
        order: 920,
    },
})
