import { describe, expect, it } from 'vitest'
import {
    awaitsInstall,
    awaitsSelfInstallConfirmation,
    beingInstalled,
    mayConfirmInstall,
    type InstallState,
} from './install-confirmation'
import { ALL_STAGES, fieldsOf } from './lifecycle'
import { STAGE_FIELDS, type InstallMode, type OrderStage } from './vocabulary'

function order(stage: OrderStage, installMode: InstallMode, shipped = 0): InstallState {
    return { stage, installMode, shippedUnits: () => shipped }
}

/** For an Order whose rule must not count its units: the customer page asks the rule of every Order it lists. */
function uncounted(): number {
    return expect.unreachable('units counted')
}

const selfInstall = order('installing', 'self_install')
const engineerInstall = order('installing', 'fsm_engineer')

describe('awaitsInstall', () => {
    it('moves only shipped units, hot spares handed over at Ship included', () => {
        expect(awaitsInstall('shipped')).toBe(true)
    })

    it('leaves units not shipped yet to Ship, a hot spare not yet handed over included', () => {
        for (const stage of ['spare_pool', 'reserved', 'staging', 'staged', 'on_order', null] as const) {
            expect(awaitsInstall(stage)).toBe(false)
        }
    })

    it('leaves units already installed or gone back', () => {
        for (const stage of ['pending_in_service', 'in_service', 'pending_return', 'missing'] as const) {
            expect(awaitsInstall(stage)).toBe(false)
        }
    })
})

describe('beingInstalled', () => {
    it('is true for an Order installing, without counting its units', () => {
        expect(beingInstalled({ ...selfInstall, shippedUnits: uncounted })).toBe(true)
    })

    it('is true for an Order a line filled again holds back while units already shipped wait at the Site', () => {
        expect(beingInstalled(order('preparing', 'fsm_engineer', 2))).toBe(true)
        expect(beingInstalled(order('delivering', 'fsm_engineer', 1))).toBe(true)
    })

    it('is false for an Order not installing with nothing shipped', () => {
        expect(beingInstalled(order('preparing', 'fsm_engineer'))).toBe(false)
        expect(beingInstalled(order('delivering', 'self_install'))).toBe(false)
    })

    it('is false once the Order is complete, cancelled or not yet sourced, whatever its units', () => {
        for (const stage of ['complete', 'cancelled', 'draft', 'awaiting_approval', 'sourcing'] as const) {
            expect(beingInstalled(order(stage, 'fsm_engineer', 1))).toBe(false)
        }
    })
})

describe('awaitsSelfInstallConfirmation', () => {
    it('is true only for a self-install being installed', () => {
        expect(awaitsSelfInstallConfirmation(selfInstall)).toBe(true)
        expect(awaitsSelfInstallConfirmation(engineerInstall)).toBe(false)
        expect(awaitsSelfInstallConfirmation(order('delivering', 'self_install'))).toBe(false)
    })

    it('is true for a self-install back in preparing with units already shipped', () => {
        expect(awaitsSelfInstallConfirmation(order('preparing', 'self_install', 1))).toBe(true)
        expect(awaitsSelfInstallConfirmation(order('preparing', 'fsm_engineer', 1))).toBe(false)
    })

    it('counts no units for an Order not self-installed', () => {
        const engineerPreparing = { ...order('preparing', 'fsm_engineer'), shippedUnits: uncounted }
        expect(awaitsSelfInstallConfirmation(engineerPreparing)).toBe(false)
    })
})

describe('mayConfirmInstall', () => {
    it('lets staff who see every Customer record any install in progress', () => {
        expect(mayConfirmInstall('everything', engineerInstall)).toBe(true)
        expect(mayConfirmInstall('everything', order('installing', 'subcontractor'))).toBe(true)
        expect(mayConfirmInstall('everything', selfInstall)).toBe(true)
    })

    it('lets staff record the units already shipped of an Order a line filled again holds back', () => {
        expect(mayConfirmInstall('everything', order('preparing', 'fsm_engineer', 1))).toBe(true)
        expect(mayConfirmInstall('everything', order('preparing', 'fsm_engineer'))).toBe(false)
    })

    it('lets Customer contacts confirm only a self-install', () => {
        for (const scope of ['own_customer', 'own_sites'] as const) {
            expect(mayConfirmInstall(scope, selfInstall)).toBe(true)
            expect(mayConfirmInstall(scope, engineerInstall)).toBe(false)
            expect(mayConfirmInstall(scope, order('installing', 'remote_hands'))).toBe(false)
            expect(mayConfirmInstall(scope, order('preparing', 'self_install', 1))).toBe(true)
            expect(mayConfirmInstall(scope, order('preparing', 'fsm_engineer', 1))).toBe(false)
        }
    })

    it('refuses everyone once the Order is no longer being installed', () => {
        expect(mayConfirmInstall('everything', order('complete', 'fsm_engineer'))).toBe(false)
        expect(mayConfirmInstall('own_sites', order('complete', 'self_install'))).toBe(false)
    })

    it('treats other users as Customer contacts', () => {
        expect(mayConfirmInstall('assigned_stockrooms', engineerInstall)).toBe(false)
        expect(mayConfirmInstall('unscoped', engineerInstall)).toBe(false)
    })
})

describe('the units Confirm installed moves', () => {
    // The action's condition has no room for the install status (254 characters), so it finds them by substatus alone.
    it('are told by a substatus no other stage has', () => {
        expect(ALL_STAGES.filter((stage) => awaitsInstall(stage))).toEqual(['shipped'])
        expect(ALL_STAGES.filter((stage) => fieldsOf(stage).substatus === STAGE_FIELDS.shipped.substatus)).toEqual(['shipped'])
    })
})
