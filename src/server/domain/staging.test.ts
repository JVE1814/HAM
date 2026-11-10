import { describe, expect, it } from 'vitest'
import { selectStagingTemplate, stagingOutcome, unmovedByClosing, type StagingTemplateView } from './staging'

const templates: StagingTemplateView[] = [
    { id: 'generic', name: 'Generic', customerId: '', manufacturerId: '', deviceClass: '', source: 'in_house', active: true },
    { id: 'cisco-switch', name: 'Cisco switch', customerId: '', manufacturerId: 'cisco', deviceClass: 'switch', source: 'in_house', active: true },
    { id: 'acme', name: 'Acme standard', customerId: 'acme', manufacturerId: '', deviceClass: '', source: 'in_house', active: true },
    { id: 'verify', name: 'Distributor verification', customerId: '', manufacturerId: '', deviceClass: '', source: 'distributor', active: true },
    { id: 'old', name: 'Old', customerId: 'acme', manufacturerId: 'cisco', deviceClass: 'switch', source: 'in_house', active: false },
]

describe('selectStagingTemplate', () => {
    it('picks the most specific matching template, customer first', () => {
        expect(selectStagingTemplate(templates, { customerId: 'acme', manufacturerId: 'cisco', deviceClass: 'switch', source: 'in_house' })).toBe('acme')
    })

    it('falls back to manufacturer and device class, then generic', () => {
        expect(selectStagingTemplate(templates, { customerId: 'globex', manufacturerId: 'cisco', deviceClass: 'switch', source: 'in_house' })).toBe('cisco-switch')
        expect(selectStagingTemplate(templates, { customerId: 'globex', manufacturerId: 'fortinet', deviceClass: 'firewall', source: 'in_house' })).toBe('generic')
    })

    it('uses verification templates for distributor-staged assets', () => {
        expect(selectStagingTemplate(templates, { customerId: 'acme', manufacturerId: 'cisco', deviceClass: 'switch', source: 'distributor' })).toBe('verify')
    })

    it('finds nothing when no template applies', () => {
        expect(selectStagingTemplate([], { customerId: 'acme', manufacturerId: 'cisco', deviceClass: 'switch', source: 'in_house' })).toBeNull()
    })
})

describe('stagingOutcome', () => {
    it('is complete when every mandatory step is done', () => {
        expect(stagingOutcome([{ mandatory: true, done: true }, { mandatory: false, done: false }])).toEqual({ complete: true, remaining: 0 })
    })

    it('counts the mandatory steps still open', () => {
        expect(stagingOutcome([{ mandatory: true, done: false }, { mandatory: true, done: false }, { mandatory: true, done: true }])).toEqual({ complete: false, remaining: 2 })
    })
})

describe('unmovedByClosing', () => {
    const task = { number: 'STG0001', lineId: 'line1', failed: false }
    const unit = { serial: 'FOC111', lineId: 'line1', stage: 'staging' as const }

    it('moves a unit in staging, or still reserved, on the line its task stages for', () => {
        expect(unmovedByClosing(task, unit)).toBeNull()
        expect(unmovedByClosing(task, { ...unit, stage: 'reserved' })).toBeNull()
        expect(unmovedByClosing({ ...task, failed: true }, unit)).toBeNull()
    })

    it('acts on the unit own line when the task was made by hand, with none', () => {
        expect(unmovedByClosing({ ...task, lineId: '' }, { ...unit, lineId: 'line9' })).toBeNull()
    })

    it('moves nothing for a unit on another line or released, and says so', () => {
        const gone = 'FOC111 is no longer on the order line STG0001 stages for: closing it moved nothing'
        expect(unmovedByClosing(task, { ...unit, lineId: 'line2' })).toBe(gone)
        expect(unmovedByClosing(task, { ...unit, lineId: '' })).toBe(gone)
        expect(unmovedByClosing({ ...task, failed: true }, { ...unit, lineId: '', stage: 'available' })).toBe(gone)
    })

    it('moves on a unit a failed close already took off its line but could not move', () => {
        expect(unmovedByClosing({ ...task, failed: true }, { ...unit, lineId: '' })).toBeNull()
    })

    it('leaves a unit in transfer on its line, to be closed once the staging centre receives it', () => {
        expect(unmovedByClosing(task, { ...unit, stage: 'in_transfer' })).toBe(
            'FOC111 is still in transfer to the staging centre: closing STG0001 moved nothing and the unit stays on its order line. ' +
                'Reopen STG0001: the unit goes into staging when the staging centre receives it; close the task then',
        )
    })

    it('moves nothing from any other stage, or one the app does not model', () => {
        expect(unmovedByClosing(task, { ...unit, stage: 'shipped' })).toBe('FOC111 is shipped, not in staging: closing STG0001 moved nothing')
        expect(unmovedByClosing(task, { ...unit, stage: null })).toBe('FOC111 is in a stage this app does not model, not in staging: closing STG0001 moved nothing')
    })
})
