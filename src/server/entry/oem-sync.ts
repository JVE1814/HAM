import type { GlideRecord } from '@servicenow/glide'
import { finishImportRow, importCoverageRow } from '../platform/imports.ts'

export function processCoverageRow(current: GlideRecord): void {
    finishImportRow(current, importCoverageRow(current))
}
