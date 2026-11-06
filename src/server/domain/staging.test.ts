import { describe, expect, it } from 'vitest'
import { selectStagingTemplate, stagingOutcome, type StagingTemplateView } from './staging'

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
