import '@servicenow/sdk/global'
import { RestApi } from '@servicenow/sdk/core'
import { postDeviceEvents } from '../../server/entry/in-service'

/* Scripted REST API: /api/x_daas_ham/naas/... */

RestApi({
    $id: Now.ID['rest_naas'],
    name: 'NaaS asset management',
    serviceId: 'naas',
    consumes: 'application/json',
    produces: 'application/json',
    shortDescription: 'Seen signals from the provider NMS and warehouse scanning operations.',
    routes: [
        {
            $id: Now.ID['rest_naas_device_events'],
            name: 'device_events',
            method: 'POST',
            path: '/device_events',
            shortDescription: 'Post a batch of device seen/down/up events (identifier = serial, provider tag or customer tag).',
            requestExample: '{ "events": [ { "identifier": "FOC1234X0AB", "event": "seen", "observed_at": "2026-11-06T10:00:00Z", "source": "nms" } ] }',
            authentication: true,
            authorization: true,
            script: postDeviceEvents,
        },
    ],
})
