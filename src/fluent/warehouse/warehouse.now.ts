import '@servicenow/sdk/global'
import { Acl, BusinessRule, Property, Record, StringColumn, Table, UiPage } from '@servicenow/sdk/core'
import { processAsnRow } from '../../server/entry/warehouse'
import { PROPERTY } from '../../server/domain/properties'
import warehousePage from '../../client/warehouse.html'
import { admin, scanners, stockroomWorkers } from '../shared/roles.now'
import { naasMenu } from '../shared/menu.now'

/* The warehouse: ASN rows from distributors, Provider tags and the scanning page. */

/*
 * An import-set staging table. Load a CSV into it with System Import Sets > Load Data; rows are processed by the
 * after-insert rule below (no transform map), which sets the row's import state and comment.
 */

/** Advance shipment notice lines from a distributor. */
export const x_daas_ham_asn_import = Table({
    name: 'x_daas_ham_asn_import',
    label: 'ASN import',
    extends: 'sys_import_set_row',
    schema: {
        distributor: StringColumn({ label: 'Distributor', maxLength: 100 }),
        po_number: StringColumn({ label: 'PO number', maxLength: 40 }),
        manufacturer: StringColumn({ label: 'Manufacturer', maxLength: 100 }),
        pid: StringColumn({ label: 'PID', maxLength: 100 }),
        serial: StringColumn({ label: 'Serial number', maxLength: 100 }),
        mac_address: StringColumn({ label: 'MAC address', maxLength: 40 }),
        claim_code: StringColumn({ label: 'OEM claim code', maxLength: 40 }),
        customer_tag: StringColumn({ label: 'Customer tag', maxLength: 80 }),
        staging_source: StringColumn({ label: 'Staging source (in_house/distributor)', maxLength: 20 }),
        ship_date: StringColumn({ label: 'Ship date', maxLength: 20 }),
        carrier: StringColumn({ label: 'Carrier', maxLength: 60 }),
        tracking_number: StringColumn({ label: 'Tracking number', maxLength: 100 }),
    },
})

BusinessRule({
    $id: Now.ID['br_asn_row'],
    name: 'NaaS - process ASN row',
    table: 'x_daas_ham_asn_import',
    when: 'after',
    action: ['insert'],
    order: 200,
    script: processAsnRow,
})

Property({
    $id: Now.ID['prop_tag_prefix'],
    name: PROPERTY.tagPrefix.name,
    type: 'string',
    value: PROPERTY.tagPrefix.default,
    description: 'Prefix of Provider tags printed at receiving (e.g. NAAS-0000042).',
    roles: { read: [admin], write: [admin] },
})

Property({
    $id: Now.ID['prop_tag_digits'],
    name: PROPERTY.tagDigits.name,
    type: 'integer',
    value: PROPERTY.tagDigits.default,
    description: 'Digits in the number part of a Provider tag.',
    roles: { read: [admin], write: [admin] },
})

Acl({
    $id: Now.ID['acl_asn_import_read'],
    type: 'record',
    table: 'x_daas_ham_asn_import',
    operation: 'read',
    roles: stockroomWorkers,
})

Acl({
    $id: Now.ID['acl_asn_import_create'],
    type: 'record',
    table: 'x_daas_ham_asn_import',
    operation: 'create',
    roles: stockroomWorkers,
})

Acl({
    $id: Now.ID['acl_asn_import_write'],
    type: 'record',
    table: 'x_daas_ham_asn_import',
    operation: 'write',
    roles: stockroomWorkers,
})

/* The warehouse scanning app (receive, put away, pick, look up, print labels). */

/** The page's name: its address is this with .do, and its ACL is named by it. */
export const WAREHOUSE_PAGE = 'x_daas_ham_warehouse'

export const warehouse = UiPage({
    $id: Now.ID['page_warehouse'],
    endpoint: `${WAREHOUSE_PAGE}.do`,
    description: 'NaaS warehouse scanning: receive, put away, pick, look up and print provider tags.',
    category: 'general',
    html: warehousePage,
    direct: true,
})

Acl({
    $id: Now.ID['acl_page_warehouse'],
    type: 'ui_page',
    name: WAREHOUSE_PAGE,
    operation: 'read',
    roles: scanners,
})

Record({
    $id: Now.ID['module_warehouse'],
    table: 'sys_app_module',
    data: {
        title: 'Warehouse scanning',
        application: naasMenu,
        link_type: 'DIRECT',
        query: `${WAREHOUSE_PAGE}.do`,
        // The roles the page's ACL grants (above).
        roles: scanners,
        active: true,
        order: 110,
    },
})

Record({
    $id: Now.ID['module_asn_import'],
    table: 'sys_app_module',
    data: {
        title: 'ASN import rows',
        application: naasMenu,
        link_type: 'LIST',
        name: 'x_daas_ham_asn_import',
        roles: stockroomWorkers,
        active: true,
        order: 610,
    },
})
