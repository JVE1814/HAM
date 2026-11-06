import '@servicenow/sdk/global'
import { RestApi } from '@servicenow/sdk/core'
import { postDeviceEvents } from '../../server/entry/in-service'
import { listStockrooms, lookupAsset, pickAsset, putAwayAsset, receiveAsset } from '../../server/entry/warehouse'

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
        {
            $id: Now.ID['rest_naas_lookup'],
            name: 'lookup_asset',
            method: 'GET',
            path: '/assets/{code}',
            shortDescription: 'Look up an asset by serial, provider tag or customer tag.',
            authentication: true,
            script: lookupAsset,
        },
        {
            $id: Now.ID['rest_naas_receive'],
            name: 'receive',
            method: 'POST',
            path: '/receive',
            shortDescription: 'Receive an asset into a stockroom (confirms ASN rows; pid creates assets without an ASN).',
            requestExample: '{ "code": "FOC1234X0AB", "stockroom": "<sys_id>", "pid": "C9300-48P-E" }',
            authentication: true,
            script: receiveAsset,
        },
        {
            $id: Now.ID['rest_naas_putaway'],
            name: 'put_away',
            method: 'POST',
            path: '/putaway',
            shortDescription: 'Move an in-stock asset to a stockroom.',
            authentication: true,
            script: putAwayAsset,
        },
        {
            $id: Now.ID['rest_naas_pick'],
            name: 'pick',
            method: 'POST',
            path: '/pick',
            shortDescription: 'Confirm a scanned asset is a staged asset of the given order.',
            authentication: true,
            script: pickAsset,
        },
        {
            $id: Now.ID['rest_naas_stockrooms'],
            name: 'stockrooms',
            method: 'GET',
            path: '/stockrooms',
            shortDescription: 'Stockrooms the user can receive into.',
            authentication: true,
            script: listStockrooms,
        },
    ],
})
