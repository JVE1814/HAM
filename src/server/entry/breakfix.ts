import { gs, type GlideRecord } from '@servicenow/glide'
import { noteReplacementComplete, raiseReplacement } from '../platform/breakfix.ts'
import { returnDefectiveToOem } from '../platform/oem-rma.ts'
import { str } from '../platform/records.ts'

export function uiRaiseReplacement(current: GlideRecord): void {
    const replacement = raiseReplacement(current)
    switch (replacement.outcome) {
        case 'raised':
            if (replacement.already) gs.addInfoMessage(replacement.already)
            return void gs.addInfoMessage(`Replacement order ${replacement.number} raised`)
        case 'already_raised':
            return void gs.addInfoMessage(`Replacement order ${replacement.number} is already raised (${replacement.stageLabel})`)
        case 'draft':
            gs.addErrorMessage(replacement.why)
            return void gs.addInfoMessage(`Replacement order ${replacement.number} is left as a draft: correct it and submit it`)
        case 'not_raised':
            if (replacement.why) gs.addErrorMessage(replacement.why)
    }
}

export function uiDefectiveReturnedToOem(current: GlideRecord): void {
    const problem = returnDefectiveToOem(current)
    if (problem) gs.addErrorMessage(problem)
}

/**
 * Script action of x_daas_ham.replacement.complete (break-fix/break-fix.now.ts), queued on a replacement Order once it is
 * complete: its case is saved, so that the case's replacement SLA stops.
 */
export function onReplacementComplete(event: GlideRecord): void {
    noteReplacementComplete(str(event, 'instance'))
}
