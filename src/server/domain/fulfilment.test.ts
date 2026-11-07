import { describe, expect, it } from 'vitest'
import { lineStageFor, orderStageFor } from './fulfilment'

describe('lineStageFor', () => {
    it('waits for stock while fewer assets than ordered are allocated', () => {
        expect(lineStageFor({ quantity: 3, assetStages: ['reserved'], cancelled: false })).toBe('awaiting_stock')
    })

    it('follows the slowest asset of the line', () => {
        expect(lineStageFor({ quantity: 2, assetStages: ['reserved', 'reserved'], cancelled: false })).toBe('sourced')
        expect(lineStageFor({ quantity: 2, assetStages: ['staging', 'staged'], cancelled: false })).toBe('staging')
        expect(lineStageFor({ quantity: 2, assetStages: ['staged', 'staged'], cancelled: false })).toBe('ready_to_ship')
        expect(lineStageFor({ quantity: 2, assetStages: ['shipped', 'pending_in_service'], cancelled: false })).toBe('shipped')
        expect(lineStageFor({ quantity: 2, assetStages: ['pending_in_service', 'in_service'], cancelled: false })).toBe('installed')
        expect(lineStageFor({ quantity: 2, assetStages: ['in_service', 'temporary_deployment'], cancelled: false })).toBe('in_service')
    })

    it('counts a hot spare that skips staging as staged', () => {
        expect(lineStageFor({ quantity: 1, assetStages: ['spare_pool'], cancelled: false })).toBe('ready_to_ship')
    })

    it('treats an asset that failed staging as still being prepared', () => {
        expect(lineStageFor({ quantity: 1, assetStages: ['pending_evaluation'], cancelled: false })).toBe('awaiting_stock')
    })

    it('treats a line for nothing as cancelled', () => {
        expect(lineStageFor({ quantity: 0, assetStages: [], cancelled: false })).toBe('cancelled')
    })

    it('stays cancelled', () => {
        expect(lineStageFor({ quantity: 1, assetStages: ['staged'], cancelled: true })).toBe('cancelled')
    })
})

describe('orderStageFor', () => {
    it('is complete when every live line is in service', () => {
        expect(orderStageFor(['in_service', 'cancelled'])).toBe('complete')
    })

    it('follows the slowest line', () => {
        expect(orderStageFor(['awaiting_stock', 'ready_to_ship'])).toBe('preparing')
        expect(orderStageFor(['ready_to_ship', 'ready_to_ship'])).toBe('delivering')
        expect(orderStageFor(['shipped', 'installed'])).toBe('installing')
        expect(orderStageFor(['installed', 'in_service'])).toBe('installing')
    })

    it('is cancelled when every line is cancelled', () => {
        expect(orderStageFor(['cancelled', 'cancelled'])).toBe('cancelled')
    })

    it('is still sourcing while a line is new', () => {
        expect(orderStageFor(['new', 'sourced'])).toBe('sourcing')
    })
})
