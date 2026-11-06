import '@servicenow/sdk/global'
import { ScheduledScript } from '@servicenow/sdk/core'
import { evaluatePendingInService, purgeDeviceEvents } from '../../server/entry/in-service'

/* Background jobs (chunked where they touch many assets, ADR 0007). */

ScheduledScript({
    $id: Now.ID['job_in_service_detection'],
    name: 'NaaS - in-service detection',
    active: true,
    frequency: 'periodically',
    executionInterval: { minutes: 15 },
    executionStart: '2026-01-01 00:00:00',
    timeZone: 'UTC',
    script: evaluatePendingInService,
})

ScheduledScript({
    $id: Now.ID['job_purge_device_events'],
    name: 'NaaS - purge old device events',
    active: true,
    frequency: 'daily',
    executionTime: { hours: 3, minutes: 10, seconds: 0 },
    timeZone: 'UTC',
    script: purgeDeviceEvents,
})
