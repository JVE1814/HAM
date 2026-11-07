import { describe, expect, it } from 'vitest'
import { followsLines, lineStageFor, orderStageFor } from './fulfilment'

describe('lineStageFor', () => {
    it('waits for stock while fewer assets than ordered are allocated', () => {
        expect(lineStageFor({ current: 'sourced', quantity: 3, assetStages: ['reserved'] })).toBe('awaiting_stock')
    })

    it('follows the slowest asset of the line', () => {
        expect(lineStageFor({ current: 'sourced', quantity: 2, assetStages: ['reserved', 'reserved'] })).toBe('sourced')
        expect(lineStageFor({ current: 'sourced', quantity: 2, assetStages: ['staging', 'staged'] })).toBe('staging')
        expect(lineStageFor({ current: 'staging', quantity: 2, assetStages: ['staged', 'staged'] })).toBe('ready_to_ship')
        expect(lineStageFor({ current: 'ready_to_ship', quantity: 2, assetStages: ['shipped', 'pending_in_service'] })).toBe('shipped')
        expect(lineStageFor({ current: 'shipped', quantity: 2, assetStages: ['pending_in_service', 'in_service'] })).toBe('installed')
        expect(lineStageFor({ current: 'installed', quantity: 2, assetStages: ['in_service', 'temporary_deployment'] })).toBe('in_service')
    })

    it('counts a hot spare that skips staging as staged', () => {
        expect(lineStageFor({ current: 'sourced', quantity: 1, assetStages: ['spare_pool'] })).toBe('ready_to_ship')
    })

    it('counts a hot spare handed over at Ship as shipped', () => {
        expect(lineStageFor({ current: 'ready_to_ship', quantity: 2, assetStages: ['shipped', 'shipped'] })).toBe('shipped')
    })

    it('treats an asset that failed staging as still being prepared', () => {
        expect(lineStageFor({ current: 'staging', quantity: 1, assetStages: ['pending_evaluation'] })).toBe('awaiting_stock')
    })

    it('lets a line not yet shipped fall back when it loses an asset', () => {
        expect(lineStageFor({ current: 'ready_to_ship', quantity: 2, assetStages: ['staged'] })).toBe('awaiting_stock')
    })

    it('keeps a delivered line where it is when its assets later leave service', () => {
        const returned = ['pending_return', 'in_service'] as const
        expect(lineStageFor({ current: 'in_service', quantity: 2, assetStages: returned })).toBe('in_service')
        expect(lineStageFor({ current: 'in_service', quantity: 1, assetStages: ['missing'] })).toBe('in_service')
        expect(lineStageFor({ current: 'in_service', quantity: 1, assetStages: ['pending_evaluation'] })).toBe('in_service')
        expect(lineStageFor({ current: 'installed', quantity: 2, assetStages: ['pending_return', 'pending_in_service'] })).toBe('installed')
        expect(lineStageFor({ current: 'shipped', quantity: 1, assetStages: ['pending_return'] })).toBe('shipped')
    })

    it('still moves a delivered line forward', () => {
        expect(lineStageFor({ current: 'shipped', quantity: 1, assetStages: ['in_service'] })).toBe('in_service')
    })

    it('lets a delivered line go into service without a unit that left before it did', () => {
        // A dead-on-arrival unit swapped out by break-fix: the rest of the line still completes.
        const swapped = ['pending_return', 'in_service', 'in_service'] as const
        expect(lineStageFor({ current: 'installed', quantity: 3, assetStages: swapped })).toBe('in_service')
        expect(lineStageFor({ current: 'installed', quantity: 3, assetStages: ['in_service', 'in_service'] })).toBe('in_service')
        expect(lineStageFor({ current: 'shipped', quantity: 2, assetStages: ['missing', 'pending_in_service'] })).toBe('installed')
    })

    it('treats a line for nothing as cancelled', () => {
        expect(lineStageFor({ current: 'sourced', quantity: 0, assetStages: [] })).toBe('cancelled')
    })

    it('stays cancelled', () => {
        expect(lineStageFor({ current: 'cancelled', quantity: 1, assetStages: ['staged'] })).toBe('cancelled')
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

describe('followsLines', () => {
    it.each(['sourcing', 'preparing', 'delivering', 'installing'])('moves a %s Order with its lines', (stage) => {
        expect(followsLines(stage)).toBe(true)
    })

    it.each(['draft', 'awaiting_approval', 'rejected', 'cancelled'])('leaves a %s Order as it is', (stage) => {
        expect(followsLines(stage)).toBe(false)
    })

    it('keeps a complete Order complete when its assets later leave service', () => {
        expect(followsLines('complete')).toBe(false)
    })
})
