import type { GlideRecord } from '@servicenow/glide'
import { finishImportRow, importAsnRow, importLifecycleRow } from '../platform/imports.ts'

export function processAsnRow(current: GlideRecord): void {
    finishImportRow(current, importAsnRow(current))
}

export function processLifecycleRow(current: GlideRecord): void {
    finishImportRow(current, importLifecycleRow(current))
}
