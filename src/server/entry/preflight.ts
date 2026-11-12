import { GlideRecord } from '@servicenow/glide'
import { JOB } from '../domain/chunked-job.ts'
import { messageOf } from '../domain/errors.ts'
import { preflightReport } from '../domain/preflight.ts'
import { PROPERTY } from '../domain/properties.ts'
import { openJobCursor } from '../platform/job-cursor.ts'
import { log } from '../platform/log.ts'
import { secretProperty } from '../platform/properties.ts'

export function runPreflight(): void {
    const report = preflightReport({
        tableExists: (table) => new GlideRecord(table).isValid(),
        roleExists: (role) => {
            const gr = new GlideRecord('sys_user_role')
            return gr.get('name', role)
        },
        webhookToken: () => secretProperty(PROPERTY.shippingWebhookToken),
    })
    for (const item of report.missing) log.error(`preflight: missing ${item}`)
    for (const problem of report.problems) log.error(`preflight: ${problem}`)
    log.info(`preflight: ${report.summary}`)

    const items = [...report.missing.map((item) => `missing ${item}`), ...report.problems]
    const result = `${report.summary}${items.length ? `: ${items.join('; ')}` : ''}`
    const refused = recordResult(result)
    if (refused) log.error(`preflight: result not recorded on job cursor preflight: ${refused}`)
}

function recordResult(result: string): string | null {
    try {
        return openJobCursor(JOB.preflight).save({ status: result, ranNow: true })
    } catch (error) {
        return messageOf(error)
    }
}
