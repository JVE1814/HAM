/**
 * The REST messages of the app and the functions each has, by name: the one list of them. The Fluent RestMessage
 * records take their name and their functions' names from here, the adapters call a function by its entry
 * (domain/oem, domain/shipping) and the transport picks the message by its (platform/oem-http, platform/rest-messages),
 * so a function an adapter calls is one its message has.
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
    shipping: {
        name: 'NaaS Shipping aggregator',
        fn: { createLabel: 'create_label' },
    },
} as const

type Messages = typeof REST_MESSAGE

/** The name of a function of one of the app's REST messages: what a request through the HTTP seam may call (domain/http). */
export type RestFunction = { [M in keyof Messages]: Messages[M]['fn'][keyof Messages[M]['fn']] }[keyof Messages]
