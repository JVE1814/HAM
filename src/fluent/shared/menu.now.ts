import '@servicenow/sdk/global'
import { ApplicationMenu, Record } from '@servicenow/sdk/core'
import { BROAD_STAFF, ROLE } from '../../server/domain/roles'
import { providerStaff, stockroomWorkers } from './roles.now'
import { WORKSPACE_PAGE } from '../workspace/workspace.now'

/*
 * A module on alm_hardware lists fleet assets only (ADR 0016: the table holds the Provider IT's equipment too): its
 * filter holds the fleet condition in each ^NQ clause, and none opens the table unfiltered (link type LIST), which
 * built-metadata.test.ts checks.
 */

export const naasMenu = ApplicationMenu({
    $id: Now.ID['menu_naas'],
    title: 'NaaS Asset Management',
    hint: 'Hardware asset management for network-as-a-service',
    roles: providerStaff,
    active: true,
})

Record({
    $id: Now.ID['module_workspace'],
    table: 'sys_app_module',
    data: {
        title: 'NaaS Asset Workspace',
        application: naasMenu,
        link_type: 'DIRECT',
        query: `${WORKSPACE_PAGE}.do`,
        roles: providerStaff,
        active: true,
        order: 100,
    },
})

Record({
    $id: Now.ID['module_sep_orders'],
    table: 'sys_app_module',
    data: {
        title: 'Orders',
        application: naasMenu,
        link_type: 'SEPARATOR',
        roles: providerStaff,
        active: true,
        order: 200,
    },
})

Record({
    $id: Now.ID['module_sep_base'],
    table: 'sys_app_module',
    data: {
        title: 'Installed base',
        application: naasMenu,
        link_type: 'SEPARATOR',
        roles: providerStaff,
        active: true,
        order: 300,
    },
})

Record({
    $id: Now.ID['module_sep_commercial'],
    table: 'sys_app_module',
    data: {
        title: 'Commercial',
        application: naasMenu,
        link_type: 'SEPARATOR',
        roles: BROAD_STAFF,
        active: true,
        order: 400,
    },
})

Record({
    $id: Now.ID['module_sep_models'],
    table: 'sys_app_module',
    data: {
        title: 'Models',
        application: naasMenu,
        link_type: 'SEPARATOR',
        roles: BROAD_STAFF,
        active: true,
        order: 500,
    },
})

Record({
    $id: Now.ID['module_sep_imports'],
    table: 'sys_app_module',
    data: {
        title: 'Imports',
        application: naasMenu,
        link_type: 'SEPARATOR',
        roles: stockroomWorkers,
        active: true,
        order: 600,
    },
})

Record({
    $id: Now.ID['module_sep_admin'],
    table: 'sys_app_module',
    data: {
        title: 'Administration',
        application: naasMenu,
        link_type: 'SEPARATOR',
        roles: [ROLE.admin],
        active: true,
        order: 900,
    },
})

Record({
    $id: Now.ID['module_sep_aftersales'],
    table: 'sys_app_module',
    data: {
        title: 'After-sales',
        application: naasMenu,
        link_type: 'SEPARATOR',
        roles: providerStaff,
        active: true,
        order: 350,
    },
})

Record({
    $id: Now.ID['module_sep_assurance'],
    table: 'sys_app_module',
    data: {
        title: 'Assurance',
        application: naasMenu,
        link_type: 'SEPARATOR',
        roles: providerStaff,
        active: true,
        order: 380,
    },
})
