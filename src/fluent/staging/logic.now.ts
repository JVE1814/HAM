import '@servicenow/sdk/global'
import { BusinessRule, Property } from '@servicenow/sdk/core'
import { guardStagingClosure, onStagingClosed, releaseWaitingSteps, stampStagingStep } from '../../server/entry/staging'
import { STAGING_TASK_STATE } from '../../server/domain/staging'
import { PROPERTY } from '../../server/domain/properties'
import { admin } from '../shared/roles.now'

BusinessRule({
    $id: Now.ID['br_staging_step_stamp'],
    name: 'NaaS - stamp staging step',
    table: 'x_daas_ham_staging_step',
    when: 'before',
    action: ['update'],
    order: 100,
    condition: 'current.done.changes()',
    script: stampStagingStep,
})

BusinessRule({
    $id: Now.ID['br_staging_step_release'],
    name: 'NaaS - release waiting OEM steps',
    table: 'x_daas_ham_staging_step',
    when: 'after',
    action: ['update'],
    order: 200,
    condition: "current.done.changes() && current.done == true && current.automation != ''",
    script: releaseWaitingSteps,
})

BusinessRule({
    $id: Now.ID['br_staging_guard_closure'],
    name: 'NaaS - staging steps done before close',
    table: 'x_daas_ham_staging_task',
    when: 'before',
    action: ['update'],
    order: 100,
    condition: `current.state.changes() && (current.state == ${STAGING_TASK_STATE.closed} || current.state == ${STAGING_TASK_STATE.incomplete} || current.state == ${STAGING_TASK_STATE.skipped})`,
    script: guardStagingClosure,
})

BusinessRule({
    $id: Now.ID['br_staging_closed'],
    name: 'NaaS - staged asset on staging closure',
    table: 'x_daas_ham_staging_task',
    when: 'after',
    action: ['update'],
    order: 200,
    condition: `current.state.changes() && current.state == ${STAGING_TASK_STATE.closed}`,
    script: onStagingClosed,
})

Property({
    $id: Now.ID['prop_staging_stockroom'],
    name: PROPERTY.stagingStockroom.name,
    type: 'string',
    value: PROPERTY.stagingStockroom.default,
    description: 'sys_id of the staging-centre stockroom reserved stock is transferred to and purchases are shipped to.',
    roles: { read: [admin], write: [admin] },
})
