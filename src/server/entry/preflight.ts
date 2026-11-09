import { GlideRecord, gs } from '@servicenow/glide'
import { messageOf } from '../domain/errors.ts'
import { preflightReport } from '../domain/preflight.ts'
import { openJobCursor } from '../platform/job-cursor.ts'

/** On-demand job "NaaS - preflight check": verifies plugins/roles and records the result. */
export function runPreflight(): void {
    const report = preflightReport({
        tableExists: (table) => new GlideRecord(table).isValid(),
        roleExists: (role) => {
            const gr = new GlideRecord('sys_user_role')
            return gr.get('name', role)
        },
    })
    for (const item of report.missing) gs.error(`[x_daas_ham] preflight: missing ${item}`)
    gs.info(`[x_daas_ham] preflight: ${report.summary}`)

    const result = `${report.summary}${report.missing.length ? `: ${report.missing.join('; ')}` : ''}`.slice(0, 255)
    const refused = recordResult(result)
    if (refused) gs.error(`[x_daas_ham] preflight: result not recorded on job cursor preflight: ${refused}`)
}

/** Keep the result on the check's row among the job cursors, as its status: null once saved, else why not. */
function recordResult(result: string): string | null {
    try {
        return openJobCursor('preflight').save({ status: result, ranNow: true })
    } catch (error) {
        return messageOf(error)
    }
}
