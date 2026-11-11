import { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fieldsOf, stageOf, type Stage } from '../domain/lifecycle.ts'
import { PROPERTY } from '../domain/properties.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'
import { moveAlongPath } from './stock.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

function unit(stage: Stage): Row {
    const { installStatus, substatus } = fieldsOf(stage)
    return { sys_id: 'a1', serial_number: 'FOC111', company: 'acme', x_daas_ham_agreement: 'ag1', install_status: installStatus, substatus: substatus ?? '' }
}

function asset(): GlideRecord {
    const gr = new GlideRecord('alm_hardware')
    gr.get('a1')
    return gr
}

const stored = () => platform.tables.alm_hardware?.[0] ?? {}
const storedStage = () => stageOf({ installStatus: String(stored().install_status), substatus: String(stored().substatus) })

beforeEach(() => {
    platform.reset()
    platform.properties = { [PROPERTY.providerCompany.name]: 'provider' }
})

describe('moveAlongPath', () => {
    it("takes a Customer's Spare pool unit to pending wipe through available, given back to the Provider on the way", () => {
        platform.tables.alm_hardware = [unit('spare_pool')]
        expect(moveAlongPath(asset(), 'pending_wipe')).toBeNull()
        expect(storedStage()).toBe('pending_wipe')
        expect(stored()).toMatchObject({ company: 'provider', x_daas_ham_agreement: '' })
    })

    it('stops at the move whose save is refused, the moves before it saved', () => {
        platform.tables.alm_hardware = [unit('spare_pool')]
        const moved = asset()
        const stopped = moveAlongPath(moved, 'pending_wipe', (to) => (to === 'pending_wipe' ? 'refused' : moved.update() ? '' : 'not saved'))
        expect(stopped).toEqual({ to: 'pending_wipe', why: 'refused' })
        expect(storedStage()).toBe('available')
    })

    it('leaves a unit it may not move where it is, with the lifecycle reason', () => {
        platform.tables.alm_hardware = [unit('in_service')]
        expect(moveAlongPath(asset(), 'pending_wipe')).toEqual({ to: 'pending_wipe', why: 'Cannot move an asset from in_service to pending_wipe' })
        expect(storedStage()).toBe('in_service')
    })
})
