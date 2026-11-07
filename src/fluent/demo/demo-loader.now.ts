import '@servicenow/sdk/global'
import { ScheduledScript } from '@servicenow/sdk/core'
import { loadDemoData } from '../../server/entry/demo-seed'

/* Installed only with `now-sdk install --demo-data`; run it once with "Execute Now". */

ScheduledScript({
    $id: Now.ID['job_load_demo_data'],
    $meta: { installMethod: 'demo' },
    name: 'NaaS - load demo data',
    active: true,
    frequency: 'on_demand',
    script: loadDemoData,
})
