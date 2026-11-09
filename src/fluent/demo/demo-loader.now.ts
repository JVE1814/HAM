import '@servicenow/sdk/global'
import { Record, ScheduledScript } from '@servicenow/sdk/core'
import { DEMO_DEPOT_GROUP, loadDemoData } from '../../server/entry/demo-seed'

/* Installed only with `now-sdk install --demo-data`; run it once with "Execute Now". */

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
