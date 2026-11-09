import { GlideRecord, gs } from '@servicenow/glide'
import { preflightReport } from '../domain/preflight.ts'
import { msToGlide, nowMs } from '../platform/clock.ts'
import { refusal } from '../platform/records.ts'

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

    const cursor = new GlideRecord('x_daas_ham_job_cursor')
    const found = cursor.get('job', 'preflight')
    if (!found) {
        cursor.initialize()
        cursor.setValue('job', 'preflight')
    }
    cursor.setValue('last_run', msToGlide(nowMs()))
    cursor.setValue('last_status', `${report.summary}${report.missing.length ? `: ${report.missing.join('; ')}` : ''}`.slice(0, 255))
    if (!(found ? cursor.update() : cursor.insert())) gs.error(`[x_daas_ham] preflight: result not recorded on job cursor preflight: ${refusal(cursor)}`)
}
