import type { GlideRecord } from '@servicenow/glide'
import { finishImportRow, importAsnRow, importLifecycleRow } from '../platform/imports.ts'

/** Import-set rows processed on insert (ASN, lifecycle CSV): each is saved with how it ended (platform/imports). */

/** After-insert rule on ASN import rows: create the in-transit Asset. */
export function processAsnRow(current: GlideRecord): void {
    finishImportRow(current, importAsnRow(current))
}

/** After-insert rule on lifecycle import rows: store the row's milestones on its Model. */
export function processLifecycleRow(current: GlideRecord): void {
    finishImportRow(current, importLifecycleRow(current))
}
