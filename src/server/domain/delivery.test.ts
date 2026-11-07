import { describe, expect, it } from 'vitest'
import { planShipment, type InstallMode, type OrderType, type ShipFacts } from './delivery'

const order: ShipFacts = {
    orderType: 'site_rollout',
    installMode: 'fsm_engineer',
    hasTrackingNumber: false,
    trackingNumberBought: false,
    hasWorkOrder: false,
    staged: 2,
    refused: 0,
    refusedReason: '',
    hotSpares: 0,
    shippingEnabled: true,
}

const noSite = 'An asset must have a site before it can be shipped'
const noAgreement = 'An asset must belong to an agreement before it can be shipped'

function onSiteWork(facts: Partial<ShipFacts>) {
    const plan = planShipment({ ...order, ...facts })
    if (!plan.ok) throw new Error(plan.errors.join('; '))
    return plan.onSiteWork
}

describe('planShipment', () => {
    it('refuses an Order with nothing staged, before anything about shipping', () => {
        expect(planShipment({ ...order, staged: 0, hotSpares: 0, shippingEnabled: false })).toEqual({
            ok: false,
            errors: ['Nothing is staged for this order yet'],
        })
    })

    it('says why when every staged Asset is refused, instead of calling the Order empty', () => {
        expect(planShipment({ ...order, staged: 0, refused: 3, refusedReason: noSite, shippingEnabled: false })).toEqual({
            ok: false,
            errors: [`3 asset(s) cannot ship: ${noSite}`],
        })
    })

    it('ships the allowed staged Assets and reports the refused ones', () => {
        expect(planShipment({ ...order, staged: 2, refused: 1, refusedReason: noSite })).toEqual({
            ok: true,
            errors: [`1 asset(s) cannot ship: ${noSite}`],
            labelPackages: 2,
            onSiteWork: { changeType: 'normal', purpose: 'install', subcontracted: false },
        })
    })

    it('links hot spares without a label when every staged Asset is refused', () => {
        expect(planShipment({ ...order, staged: 0, refused: 2, refusedReason: noSite, hotSpares: 1 })).toMatchObject({
            ok: true,
            errors: [`2 asset(s) cannot ship: ${noSite}`],
            labelPackages: null,
        })
    })

    it('reports refused Assets ahead of a missing tracking number', () => {
        expect(planShipment({ ...order, refused: 1, refusedReason: noSite, shippingEnabled: false })).toEqual({
            ok: false,
            errors: [`1 asset(s) cannot ship: ${noSite}`, 'Enter the carrier and tracking number before shipping'],
        })
    })

    it('ships hot spares alone without a label, even with the aggregator off', () => {
        expect(planShipment({ ...order, staged: 0, hotSpares: 1, shippingEnabled: false })).toEqual({
            ok: true,
            errors: [],
            labelPackages: null,
            onSiteWork: { changeType: 'normal', purpose: 'install', subcontracted: false },
        })
    })

    it('asks for a hand-entered tracking number when staged Assets need a carrier and the aggregator is off', () => {
        expect(planShipment({ ...order, shippingEnabled: false })).toEqual({
            ok: false,
            errors: ['Enter the carrier and tracking number before shipping'],
        })
    })

    it('buys one package per staged Asset and none for hot spares', () => {
        const plan = planShipment({ ...order, staged: 3, hotSpares: 2 })
        expect(plan.ok && plan.labelPackages).toBe(3)
    })

    it('buys no label once a tracking number was entered by hand', () => {
        const plan = planShipment({ ...order, hasTrackingNumber: true, shippingEnabled: false })
        expect(plan.ok && plan.labelPackages).toBeNull()
    })

    it("buys a new label for Assets staged after an earlier Ship, whose label covers only that Ship's boxes", () => {
        const plan = planShipment({ ...order, staged: 1, hasTrackingNumber: true, trackingNumberBought: true })
        expect(plan.ok && plan.labelPackages).toBe(1)
    })

    it('asks for a tracking number when a later Ship needs a label and the aggregator is now off', () => {
        expect(planShipment({ ...order, hasTrackingNumber: true, trackingNumberBought: true, shippingEnabled: false })).toEqual({
            ok: false,
            errors: ['Enter the carrier and tracking number before shipping'],
        })
    })

    it('hands over hot spares alone on a later Ship without another label', () => {
        const plan = planShipment({ ...order, staged: 0, hotSpares: 1, hasTrackingNumber: true, trackingNumberBought: true })
        expect(plan.ok && plan.labelPackages).toBeNull()
    })

    it('reports a refused hot spare like a refused staged Asset', () => {
        expect(planShipment({ ...order, staged: 0, hotSpares: 0, refused: 1, refusedReason: noAgreement })).toEqual({
            ok: false,
            errors: [`1 asset(s) cannot ship: ${noAgreement}`],
        })
    })

    it('buys no label for remote hands, whose work is subcontracted', () => {
        expect(planShipment({ ...order, installMode: 'remote_hands', shippingEnabled: false })).toEqual({
            ok: true,
            errors: [],
            labelPackages: null,
            onSiteWork: { changeType: 'normal', purpose: 'install', subcontracted: true },
        })
    })

    it('opens no on-site work for a self-install', () => {
        expect(onSiteWork({ installMode: 'self_install' })).toBeNull()
    })

    it('opens no on-site work twice', () => {
        expect(onSiteWork({ hasWorkOrder: true })).toBeNull()
    })

    it('runs a device replace as a standard change that swaps Assets', () => {
        expect(onSiteWork({ orderType: 'device_replace' })).toMatchObject({ changeType: 'standard', purpose: 'swap' })
    })

    it('runs a refresh as a normal change that swaps Assets', () => {
        expect(onSiteWork({ orderType: 'refresh' })).toMatchObject({ changeType: 'normal', purpose: 'swap' })
    })

    it.each<OrderType>(['site_rollout', 'device_add', 'temporary'])('runs a %s as a normal change that installs Assets', (orderType) => {
        expect(onSiteWork({ orderType })).toMatchObject({ changeType: 'normal', purpose: 'install' })
    })

    it('subcontracts the work for a subcontractor but not for a field engineer', () => {
        expect(onSiteWork({ installMode: 'subcontractor' })?.subcontracted).toBe(true)
        expect(onSiteWork({ installMode: 'fsm_engineer' })?.subcontracted).toBe(false)
    })

    it('treats an unknown Order type or Install mode as a normal install by the Provider', () => {
        const plan = planShipment({ ...order, orderType: 'other' as OrderType, installMode: 'other' as InstallMode })
        expect(plan).toEqual({
            ok: true,
            errors: [],
            labelPackages: 2,
            onSiteWork: { changeType: 'normal', purpose: 'install', subcontracted: false },
        })
    })
})
