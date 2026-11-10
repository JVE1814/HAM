import '@servicenow/sdk/global'
import { ChoiceColumn, DateTimeColumn, IntegerColumn, ReferenceColumn, StringColumn, Table } from '@servicenow/sdk/core'
import { DEVICE_EVENT_KIND_CHOICES, DEVICE_EVENT_SOURCE_CHOICES } from '../../server/domain/vocabulary'
import { FLEET_CONDITION } from '../../server/domain/fleet'
import { LOCK_NAME_LENGTH } from '../../server/domain/lock-names'

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
