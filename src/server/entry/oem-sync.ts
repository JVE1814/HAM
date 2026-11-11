import type { GlideRecord } from '@servicenow/glide'
import { finishImportRow, importCoverageRow } from '../platform/imports.ts'
import { syncCoverage, syncLifecycle, syncRmaStatus } from '../platform/oem-sync.ts'

/** OEM lifecycle, coverage and RMA-status synchronisation (P2.1, ADR 0008): the jobs and the coverage CSV import. */

export function syncOemLifecycle(): void {
    syncLifecycle()
}

export function syncOemCoverage(): void {
    syncCoverage()
}

export function syncOemRmaStatus(): void {
    syncRmaStatus()
}

export function processCoverageRow(current: GlideRecord): void {
    finishImportRow(current, importCoverageRow(current))
}
