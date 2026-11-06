import '@servicenow/sdk/global'
import { BusinessRule } from '@servicenow/sdk/core'
import {
    scopeAssets,
    scopeCustomerRecords,
    scopeOrderLines,
    scopeOrders,
    scopeStagingTasks,
    scopeStockrooms,
    scopeTransferOrders,
} from '../../server/entry/visibility'

/* Before-query rules that scope lists and lookups by customer, site or stockroom (ADR 0005). */

BusinessRule({
    $id: Now.ID['br_scope_alm_hardware'],
    name: 'NaaS - scope assets',
    table: 'alm_hardware',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeAssets,
})

BusinessRule({
    $id: Now.ID['br_scope_alm_stockroom'],
    name: 'NaaS - scope stockrooms',
    table: 'alm_stockroom',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeStockrooms,
})

BusinessRule({
    $id: Now.ID['br_scope_alm_transfer_order'],
    name: 'NaaS - scope transfer orders',
    table: 'alm_transfer_order',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeTransferOrders,
})

BusinessRule({
    $id: Now.ID['br_scope_staging_task'],
    name: 'NaaS - scope staging tasks',
    table: 'x_daas_ham_staging_task',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeStagingTasks,
})

BusinessRule({
    $id: Now.ID['br_scope_order'],
    name: 'NaaS - scope orders',
    table: 'x_daas_ham_order',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeOrders,
})

BusinessRule({
    $id: Now.ID['br_scope_order_line'],
    name: 'NaaS - scope order lines',
    table: 'x_daas_ham_order_line',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeOrderLines,
})

BusinessRule({
    $id: Now.ID['br_scope_agreement'],
    name: 'NaaS - scope agreements',
    table: 'x_daas_ham_agreement',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeCustomerRecords,
})

BusinessRule({
    $id: Now.ID['br_scope_subscription_line'],
    name: 'NaaS - scope subscription lines',
    table: 'x_daas_ham_subscription_line',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeCustomerRecords,
})

BusinessRule({
    $id: Now.ID['br_scope_catalog_entry'],
    name: 'NaaS - scope catalog entries',
    table: 'x_daas_ham_catalog_entry',
    when: 'before',
    action: ['query'],
    order: 50,
    script: scopeCustomerRecords,
})
