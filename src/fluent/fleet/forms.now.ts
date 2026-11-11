import '@servicenow/sdk/global'
import { Record } from '@servicenow/sdk/core'
import { FLEET_IN_STAGE } from '../../server/domain/fleet'
import { providerStaff } from '../shared/roles.now'
import { naasMenu } from '../shared/menu.now'

Record({
    $id: Now.ID['module_assets_in_service'],
    table: 'sys_app_module',
    data: {
        title: 'In service',
        application: naasMenu,
        link_type: 'FILTER',
        name: 'alm_hardware',
        filter: FLEET_IN_STAGE.in_service,
        roles: providerStaff,
        active: true,
        order: 310,
    },
})

Record({
    $id: Now.ID['module_assets_pending'],
    table: 'sys_app_module',
    data: {
        title: 'Installed, not yet seen',
        application: naasMenu,
        link_type: 'FILTER',
        name: 'alm_hardware',
        filter: FLEET_IN_STAGE.pending_in_service,
        roles: providerStaff,
        active: true,
        order: 320,
    },
})

Record({
    $id: Now.ID['module_spare_pools'],
    table: 'sys_app_module',
    data: {
        title: 'Spare pools',
        application: naasMenu,
        link_type: 'FILTER',
        name: 'alm_hardware',
        filter: FLEET_IN_STAGE.spare_pool,
        roles: providerStaff,
        active: true,
        order: 330,
    },
})
