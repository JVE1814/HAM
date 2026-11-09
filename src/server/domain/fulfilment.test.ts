import { describe, expect, it } from 'vitest'
import {
    anythingShipped,
    approvalAwaited,
    followsLines,
    leftInTransit,
    LINE_STAGES,
    lineStageFor,
    orderStageFor,
    refillsLine,
    siteRecoveryLineQuery,
    type LineStage,
} from './fulfilment'

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

    it('counts a unit in transfer to the staging centre as sourced, on its way', () => {
        expect(lineStageFor({ current: 'awaiting_stock', quantity: 1, assetStages: ['in_transfer'] })).toBe('sourced')
        expect(lineStageFor({ current: 'sourced', quantity: 2, assetStages: ['in_transfer', 'staged'] })).toBe('sourced')
        expect(lineStageFor({ current: 'sourced', quantity: 3, assetStages: ['in_transfer', 'reserved'] })).toBe('awaiting_stock')
    })

    it('moves on once a unit in transfer is received and goes into staging', () => {
        expect(lineStageFor({ current: 'sourced', quantity: 2, assetStages: ['staging', 'staged'] })).toBe('staging')
        expect(lineStageFor({ current: 'sourced', quantity: 1, assetStages: ['reserved'] })).toBe('sourced')
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

    it('sends a shipped line filled again after a unit left in transit back to awaiting stock', () => {
        expect(lineStageFor({ current: 'shipped', quantity: 1, assetStages: [], refill: true })).toBe('awaiting_stock')
        const rest = ['pending_in_service', 'in_service'] as const
        expect(lineStageFor({ current: 'shipped', quantity: 3, assetStages: rest, refill: true })).toBe('awaiting_stock')
    })

    it('follows a line filled again like one not yet delivered, its installed units included', () => {
        const refilled = ['in_service', 'pending_in_service', 'staged'] as const
        expect(lineStageFor({ current: 'awaiting_stock', quantity: 3, assetStages: refilled })).toBe('ready_to_ship')
        const shipped = ['in_service', 'pending_in_service', 'shipped'] as const
        expect(lineStageFor({ current: 'ready_to_ship', quantity: 3, assetStages: shipped })).toBe('shipped')
    })

    it('counts a unit of a line filled again that left after install as delivered', () => {
        // Swapped out, then received and evaluated while the line waits for the unit lost in transit.
        for (const left of ['pending_return', 'pending_evaluation', 'pending_wipe'] as const) {
            expect(lineStageFor({ current: 'awaiting_stock', quantity: 2, assetStages: [left] })).toBe('awaiting_stock')
            expect(lineStageFor({ current: 'awaiting_stock', quantity: 2, assetStages: [left, 'staged'] })).toBe('ready_to_ship')
        }
    })

    it('does not count a unit lost before Ship as delivered', () => {
        expect(lineStageFor({ current: 'staging', quantity: 2, assetStages: ['missing', 'staged'] })).toBe('awaiting_stock')
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

    it('is never complete while a line is in a stage the app does not know, read from a record as it is', () => {
        const unknown = 'on_hold' as LineStage
        expect(orderStageFor(['in_service', unknown])).toBe('sourcing')
        expect(orderStageFor([unknown])).toBe('sourcing')
        expect(orderStageFor(['' as LineStage, 'in_service', 'cancelled'])).toBe('sourcing')
    })

    it('derives every live line stage to a stage of its own, complete only from in service', () => {
        const live = LINE_STAGES.filter((stage) => stage !== 'cancelled')
        expect(live.map((stage) => orderStageFor([stage]))).toEqual([
            'sourcing',
            'preparing',
            'preparing',
            'preparing',
            'delivering',
            'installing',
            'installing',
            'complete',
        ])
    })
})

describe('leftInTransit', () => {
    it.each(['missing', 'pending_return'] as const)('is a unit shipped, then %s', (to) => {
        expect(leftInTransit('shipped', to)).toBe(true)
    })

    it('is not a unit that reached the Site', () => {
        expect(leftInTransit('shipped', 'pending_in_service')).toBe(false)
    })

    it.each(['pending_in_service', 'in_service', 'temporary_deployment'] as const)('is not a unit leaving %s', (from) => {
        expect(leftInTransit(from, 'pending_return')).toBe(false)
        expect(leftInTransit(from, 'missing')).toBe(false)
    })

    it('is not a unit lost before Ship', () => {
        expect(leftInTransit('reserved', 'missing')).toBe(false)
        expect(leftInTransit('in_transfer', 'available')).toBe(false)
        expect(leftInTransit(null, 'missing')).toBe(false)
    })
})

describe('refillsLine', () => {
    it.each(['shipped', 'ready_to_ship', 'awaiting_stock', 'sourced', 'staging'] as const)('fills a %s line again', (stage) => {
        expect(refillsLine({ stage, siteRecovery: false })).toBe(true)
    })

    it('leaves a line on a whole-Site recovery, which brings everything back', () => {
        expect(refillsLine({ stage: 'shipped', siteRecovery: true })).toBe(false)
    })

    it.each(['installed', 'in_service', 'cancelled', 'new'] as const)('leaves a %s line as it is', (stage) => {
        expect(refillsLine({ stage, siteRecovery: false })).toBe(false)
    })

    it('finds the Asset awaited back on a site decommission or agreement end', () => {
        expect(siteRecoveryLineQuery('a1')).toBe('asset=a1^status=awaiting^return_order.triggerINsite_decommission,agreement_end')
    })
})

describe('anythingShipped', () => {
    it('is a delivered line', () => {
        for (const stage of ['shipped', 'installed', 'in_service'] as const) {
            expect(anythingShipped({ lineStages: ['ready_to_ship', stage], unitStages: [] })).toBe(true)
        }
    })

    it('is a unit sent on a line not delivered whole (a partial Ship, a hot spare handed over)', () => {
        expect(anythingShipped({ lineStages: ['ready_to_ship'], unitStages: ['staged', 'shipped'] })).toBe(true)
    })

    it('is a unit installed on a line filled again after a unit left in transit', () => {
        expect(anythingShipped({ lineStages: ['awaiting_stock'], unitStages: ['in_service'] })).toBe(true)
        expect(anythingShipped({ lineStages: ['awaiting_stock'], unitStages: ['pending_return'] })).toBe(true)
    })

    it('is nothing before Ship', () => {
        const unitStages = ['reserved', 'in_transfer', 'staging', 'staged', 'spare_pool', 'missing', null] as const
        expect(anythingShipped({ lineStages: ['awaiting_stock', 'ready_to_ship', 'cancelled'], unitStages })).toBe(false)
    })
})

describe('approvalAwaited', () => {
    it('names the group still asked to decide', () => {
        const decisions = [
            { group: 'customer_admin', state: 'approved' },
            { group: 'account_manager', state: 'requested' },
        ] as const
        expect(approvalAwaited(['customer_admin', 'account_manager'], decisions)).toBe(
            'waiting for the account manager (or the asset managers) to decide',
        )
    })

    it('says no approval is still requested from the groups missing one', () => {
        const decisions = [{ group: 'customer_admin', state: 'cancelled' }] as const
        expect(approvalAwaited(['customer_admin', 'account_manager'], decisions)).toBe(
            'no approval from a Customer admin and the account manager (or the asset managers) and none still requested',
        )
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
