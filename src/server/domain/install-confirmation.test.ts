import { describe, expect, it } from 'vitest'
import { awaitsSelfInstallConfirmation, mayConfirmInstall } from './install-confirmation'

const selfInstall = { stage: 'installing', installMode: 'self_install' }
const engineerInstall = { stage: 'installing', installMode: 'fsm_engineer' }

describe('awaitsSelfInstallConfirmation', () => {
    it('is true only for a self-install being installed', () => {
        expect(awaitsSelfInstallConfirmation(selfInstall)).toBe(true)
        expect(awaitsSelfInstallConfirmation(engineerInstall)).toBe(false)
        expect(awaitsSelfInstallConfirmation({ stage: 'delivering', installMode: 'self_install' })).toBe(false)
    })
})

describe('mayConfirmInstall', () => {
    it('lets staff who see every Customer record any install in progress', () => {
        expect(mayConfirmInstall('everything', engineerInstall)).toBe(true)
        expect(mayConfirmInstall('everything', { stage: 'installing', installMode: 'subcontractor' })).toBe(true)
        expect(mayConfirmInstall('everything', selfInstall)).toBe(true)
    })

    it('lets Customer contacts confirm only a self-install', () => {
        for (const scope of ['own_customer', 'own_sites'] as const) {
            expect(mayConfirmInstall(scope, selfInstall)).toBe(true)
            expect(mayConfirmInstall(scope, engineerInstall)).toBe(false)
            expect(mayConfirmInstall(scope, { stage: 'installing', installMode: 'remote_hands' })).toBe(false)
        }
    })

    it('refuses everyone once the Order is no longer being installed', () => {
        expect(mayConfirmInstall('everything', { stage: 'complete', installMode: 'fsm_engineer' })).toBe(false)
        expect(mayConfirmInstall('own_sites', { stage: 'complete', installMode: 'self_install' })).toBe(false)
    })

    it('treats other users as Customer contacts', () => {
        expect(mayConfirmInstall('assigned_stockrooms', engineerInstall)).toBe(false)
        expect(mayConfirmInstall('unscoped', engineerInstall)).toBe(false)
    })
})
