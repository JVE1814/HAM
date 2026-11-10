import type { GlideRecord } from '@servicenow/glide'
import { finishImportRow, importCoverageRow } from '../platform/imports.ts'
import { syncCoverage, syncLifecycle, syncRmaStatus } from '../platform/oem-sync.ts'

/** OEM lifecycle, coverage and RMA-status synchronisation (P2.1, ADR 0008): the jobs and the coverage CSV import. */

/** Daily: EoX milestones for NaaS Models (those with an OEM PID) of every vendor with a lifecycle API. */
export function syncOemLifecycle(): void {
    syncLifecycle()
}

/** Every 4 hours: OEM coverage of the fleet assets not checked for the refresh interval (platform/oem-sync `syncCoverage`). */
export function syncOemCoverage(): void {
    syncCoverage()
}

/** Hourly: status of open OEM RMAs for vendors with an RMA lookup API. */
export function syncOemRmaStatus(): void {
    syncRmaStatus()
}

/** After-insert rule on coverage import rows (vendors without an API): the row ends as its import did. */
export function processCoverageRow(current: GlideRecord): void {
    finishImportRow(current, importCoverageRow(current))
}
