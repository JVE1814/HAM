import '@servicenow/sdk/global'
import { Record, ScheduledScript } from '@servicenow/sdk/core'
import { DEMO_DEPOT_GROUP, loadDemoData } from '../../server/entry/demo-seed'

/*
 * Demo data (installMethod demo): the SDK installs it unless the app is installed with `now-sdk install --no-demoData`,
 * so install production that way (README "Install"). Run it once with "Execute Now"; it loads nothing on an instance in
 * use (entry/demo-seed `demoRefusal`).
 */

/*
 * The group the demo depots are assigned to (ADR 0018). It ships as a record because the job cannot create it:
 * sys_user_group lets other scopes read it, not create or update (Brazil instance, 2026-11-09).
 */
Record({
    $id: Now.ID['demo_depot_group'],
    $meta: { installMethod: 'demo' },
    table: 'sys_user_group',
    data: {
        name: DEMO_DEPOT_GROUP,
        description: 'Demo data: the inventory techs of the demo central depot and staging centre.',
        active: true,
    },
})

ScheduledScript({
    $id: Now.ID['job_load_demo_data'],
    $meta: { installMethod: 'demo' },
    name: 'NaaS - load demo data',
    active: true,
    frequency: 'on_demand',
    script: loadDemoData,
})
