import '@servicenow/sdk/global'
import { ChoiceColumn, DateTimeColumn, IntegerColumn, ReferenceColumn, StringColumn, Table } from '@servicenow/sdk/core'
import { DEVICE_EVENT_KIND_CHOICES, DEVICE_EVENT_SOURCE_CHOICES } from '../../server/domain/vocabulary'

/** A Seen signal (state change only) from monitoring for one Asset. */
export const x_daas_ham_device_event = Table({
    name: 'x_daas_ham_device_event',
    label: 'Device event',
    schema: {
        // Fleet assets only (ADR 0016): domain/fleet `fleetCondition()`.
        asset: ReferenceColumn({ label: 'Asset', referenceTable: 'alm_hardware', referenceQual: 'x_daas_ham_fleet=true' }),
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

/** Where a chunked job stopped, so the next run resumes there (ADR 0007). */
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
        name: StringColumn({ label: 'Lock', maxLength: 100, mandatory: true }),
    },
    index: [{ name: 'x_daas_ham_jl_name', unique: true, element: 'name' }],
})
