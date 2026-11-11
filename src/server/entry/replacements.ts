import type { GlideRecord } from '@servicenow/glide'
import { noteReplacementComplete } from '../platform/breakfix.ts'
import { str } from '../platform/records.ts'

/**
 * Script action of x_daas_ham.replacement.complete (break-fix/break-fix.now.ts), queued on a replacement Order once it is
 * complete (platform/fulfilment `recomputeOrder`): its case is saved, so that the case's replacement SLA stops. The
 * Order is the event's record, read again by its sys_id there.
 */
export function onReplacementComplete(event: GlideRecord): void {
    noteReplacementComplete(str(event, 'instance'))
}
