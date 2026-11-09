import '@servicenow/sdk/global'
import { ScheduledScript } from '@servicenow/sdk/core'
import { loadDemoData } from '../../server/entry/demo-seed'

/*
 * Demo data (installMethod demo): the SDK installs it unless the app is installed with `now-sdk install --no-demoData`,
 * so install production that way (README "Install"). Run it once with "Execute Now"; it loads nothing on an instance in
 * use (entry/demo-seed `demoRefusal`).
 */

ScheduledScript({
    $id: Now.ID['job_load_demo_data'],
    $meta: { installMethod: 'demo' },
    name: 'NaaS - load demo data',
    active: true,
    frequency: 'on_demand',
    script: loadDemoData,
})
