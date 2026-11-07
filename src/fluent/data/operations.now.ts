import '@servicenow/sdk/global'
import { ChoiceColumn, DateTimeColumn, IntegerColumn, ReferenceColumn, StringColumn, Table } from '@servicenow/sdk/core'

/** Assigns an inventory tech to a Stockroom; drives stockroom-scoped visibility (ADR 0005). */
export const x_daas_ham_stockroom_member = Table({
    name: 'x_daas_ham_stockroom_member',
    label: 'Stockroom member',
    schema: {
        user: ReferenceColumn({ label: 'User', referenceTable: 'sys_user', mandatory: true }),
        stockroom: ReferenceColumn({ label: 'Stockroom', referenceTable: 'alm_stockroom', mandatory: true }),
    },
    index: [{ name: 'x_daas_ham_sm_user', unique: false, element: 'user' }],
})

/** A Seen signal (state change only) from monitoring for one Asset. */
export const x_daas_ham_device_event = Table({
    name: 'x_daas_ham_device_event',
    label: 'Device event',
    schema: {
        asset: ReferenceColumn({ label: 'Asset', referenceTable: 'alm_hardware' }),
        identifier: StringColumn({ label: 'Identifier', maxLength: 100, mandatory: true }),
        event: ChoiceColumn({
            label: 'Event',
            choices: {
                seen: { label: 'Seen', sequence: 0 },
                down: { label: 'Down', sequence: 1 },
                up: { label: 'Up', sequence: 2 },
            },
            mandatory: true,
            dropdown: 'dropdown_without_none',
        }),
        source: ChoiceColumn({
            label: 'Source',
            choices: {
                discovery: { label: 'Discovery', sequence: 0 },
                connector: { label: 'Service Graph Connector', sequence: 1 },
                nms: { label: 'Provider NMS', sequence: 2 },
            },
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
    schema: {
        name: StringColumn({ label: 'Lock', maxLength: 100, mandatory: true }),
    },
    index: [{ name: 'x_daas_ham_jl_name', unique: true, element: 'name' }],
})
