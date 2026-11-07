import '@servicenow/sdk/global'
import { ScheduledScript } from '@servicenow/sdk/core'
import { evaluatePendingInService, purgeDeviceEvents } from '../../server/entry/in-service'
import { normalizeRawModels, rollLifecyclePhases } from '../../server/entry/models'
import { syncOemCoverage, syncOemLifecycle, syncOemRmaStatus } from '../../server/entry/oem-sync'
import { runPreflight } from '../../server/entry/preflight'
import { topUpSparePools } from '../../server/entry/spare-pool'

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

ScheduledScript({
    $id: Now.ID['job_normalize_raw_models'],
    name: 'NaaS - normalize discovered models',
    active: true,
    frequency: 'periodically',
    executionInterval: { hours: 1 },
    executionStart: '2026-01-01 00:20:00',
    timeZone: 'UTC',
    script: normalizeRawModels,
})

ScheduledScript({
    $id: Now.ID['job_roll_lifecycle_phases'],
    name: 'NaaS - roll lifecycle phases',
    active: true,
    frequency: 'daily',
    executionTime: { hours: 0, minutes: 15, seconds: 0 },
    timeZone: 'UTC',
    script: rollLifecyclePhases,
})

ScheduledScript({
    $id: Now.ID['job_spare_pool_top_up'],
    name: 'NaaS - spare pool top-up',
    active: true,
    frequency: 'daily',
    executionTime: { hours: 2, minutes: 40, seconds: 0 },
    timeZone: 'UTC',
    script: topUpSparePools,
})

ScheduledScript({
    $id: Now.ID['job_preflight'],
    name: 'NaaS - preflight check',
    active: true,
    frequency: 'on_demand',
    script: runPreflight,
})

ScheduledScript({
    $id: Now.ID['job_oem_lifecycle'],
    name: 'NaaS - sync OEM lifecycle (EoX)',
    active: true,
    frequency: 'daily',
    executionTime: { hours: 1, minutes: 35, seconds: 0 },
    timeZone: 'UTC',
    script: syncOemLifecycle,
})

ScheduledScript({
    $id: Now.ID['job_oem_coverage'],
    name: 'NaaS - sync OEM coverage',
    active: true,
    frequency: 'periodically',
    executionInterval: { hours: 4 },
    executionStart: '2026-01-01 00:50:00',
    timeZone: 'UTC',
    script: syncOemCoverage,
})

ScheduledScript({
    $id: Now.ID['job_oem_rma_status'],
    name: 'NaaS - sync OEM RMA status',
    active: true,
    frequency: 'periodically',
    executionInterval: { hours: 1 },
    executionStart: '2026-01-01 00:05:00',
    timeZone: 'UTC',
    script: syncOemRmaStatus,
})
