import type { GlideRecord } from '@servicenow/glide'
import { importCoverageRow } from '../platform/coverage.ts'
import { finishImportRow } from '../platform/records.ts'

export function processCoverageRow(current: GlideRecord): void {
    finishImportRow(current, importCoverageRow(current))
}
