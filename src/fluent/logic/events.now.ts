import '@servicenow/sdk/global'
import { Record, ScriptAction } from '@servicenow/sdk/core'
import { sourceOrder } from '../../server/entry/orders'

/* Events fired by platform/events.ts and the script actions that consume them. */

export const orderSourceEvent = Record({
    $id: Now.ID['event_order_source'],
    table: 'sysevent_register',
    data: {
        suffix: 'order.source',
        event_name: 'x_daas_ham.order.source',
        table: 'x_daas_ham_order',
        description: 'An approved Order needs its lines sourced.',
        fired_by: 'entry/orders.ts startSourcing',
        priority: 100,
    },
})

ScriptAction({
    $id: Now.ID['sa_order_source'],
    name: 'NaaS - source order',
    eventName: 'x_daas_ham.order.source',
    active: true,
    script: sourceOrder,
    description: 'Allocates stock, requests transfers and purchases, and opens staging tasks for an approved Order.',
})
