/**
 * The OEM REST messages and the functions each has, by name: the one list of them. The Fluent RestMessage records take
 * their name and their functions' names from here, the adapters (domain/oem) call a function by its entry and the
 * transport picks the message by its (platform/oem-sync, platform/rest-messages), so a function an adapter calls is
 * one its message has.
 */
export const REST_MESSAGE = {
    ciscoSupport: {
        name: 'NaaS Cisco Support',
        fn: { eoxByPid: 'eox_by_pid', coverageBySerial: 'coverage_by_serial', rmaStatus: 'rma_status' },
    },
    meraki: {
        name: 'NaaS Meraki Dashboard',
        fn: { inventoryByModel: 'inventory_by_model', claimInventory: 'claim_inventory' },
    },
    fortiCare: {
        name: 'NaaS FortiCare',
        fn: { productsList: 'products_list', registerProducts: 'register_products' },
    },
    mist: {
        name: 'NaaS HPE Mist',
        fn: { jsiByModel: 'jsi_by_model', jsiBySerial: 'jsi_by_serial', claimInventory: 'claim_inventory' },
    },
    greenLake: {
        name: 'NaaS HPE GreenLake',
        fn: { addDevices: 'add_devices', findDevice: 'find_device', assignSubscription: 'assign_subscription' },
    },
    fortiZtp: {
        name: 'NaaS FortiZTP',
        fn: { provisionDevice: 'provision_device' },
    },
    checkPoint: {
        name: 'NaaS Check Point Zero Touch',
        fn: { login: 'login', claimGateway: 'claim_gateway', logout: 'logout' },
    },
} as const

export type OemMessageName = (typeof REST_MESSAGE)[keyof typeof REST_MESSAGE]['name']
