import { describe, expect, it } from 'vitest'
import { ALL_STAGES, checkTransition, type TransitionFacts } from './lifecycle'
import {
    closureMoveProblem,
    newerTask,
    selectStagingTemplate,
    stageOnClosure,
    stagingClosing,
    stagingClosureRefusal,
    type ClosingAsset,
    type ClosingTask,
    type StagingTemplateView,
} from './staging'

const facts: TransitionFacts = { hasSite: true, hasAgreement: true, legalOwner: 'provider', wipeEvidenceComplete: false }

const templates: StagingTemplateView[] = [
    { id: 'generic', name: 'Generic', customerId: '', manufacturerId: '', deviceClass: '', source: 'in_house' },
    { id: 'cisco-switch', name: 'Cisco switch', customerId: '', manufacturerId: 'cisco', deviceClass: 'switch', source: 'in_house' },
    { id: 'acme', name: 'Acme standard', customerId: 'acme', manufacturerId: '', deviceClass: '', source: 'in_house' },
    { id: 'verify', name: 'Distributor verification', customerId: '', manufacturerId: '', deviceClass: '', source: 'distributor' },
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

describe('stageOnClosure', () => {
    it('stages a unit that passed and sends one that failed for evaluation', () => {
        expect(stageOnClosure(false)).toBe('staged')
        expect(stageOnClosure(true)).toBe('pending_evaluation')
    })
})

describe('stagingClosing', () => {
    it('takes Closed Complete as complete, Closed Incomplete and Closed Skipped as skipped, and no open state', () => {
        expect(['3', '4', '7'].map(stagingClosing)).toEqual(['complete', 'skipped', 'skipped'])
        expect(['-5', '1', '2', ''].map(stagingClosing)).toEqual([null, null, null, null])
    })
})

describe('stagingClosureRefusal', () => {
    const task: ClosingTask = { number: 'NSTG1', closing: 'complete', failed: false, lineId: 'L1', newerTask: '' }
    const failed: ClosingTask = { ...task, failed: true }
    const unit: ClosingAsset = { serial: 'SN1', stage: 'staging', lineId: 'L1', lineOpen: true }
    const done = [{ mandatory: true, done: true }]
    const open = [{ mandatory: true, done: false }, { mandatory: false, done: false }]
    const inTransfer = 'SN1 is still in transfer to the staging centre: close NSTG1 once the staging centre receives it'

    it('closes a unit in staging on its line once every mandatory step is done; a failed one with steps open', () => {
        expect(stagingClosureRefusal(task, unit, done)).toBeNull()
        expect(stagingClosureRefusal(task, unit, [])).toBeNull()
        expect(stagingClosureRefusal(task, unit, open)).toBe('1 mandatory staging step(s) are still open')
        expect(stagingClosureRefusal(failed, unit, open)).toBeNull()
    })

    it('closes a unit still reserved for its line (moved into staging first), and one already at its result stage', () => {
        expect(stagingClosureRefusal(task, { ...unit, stage: 'reserved' }, done)).toBeNull()
        expect(stagingClosureRefusal(failed, { ...unit, stage: 'reserved' }, open)).toBeNull()
        expect(stagingClosureRefusal(task, { ...unit, stage: 'staged' }, done)).toBeNull()
        // Reopened and closed again once moved, wherever its line: it moves nothing more.
        expect(stagingClosureRefusal(failed, { ...unit, stage: 'pending_evaluation', lineId: '' }, [])).toBeNull()
    })

    it('refuses a unit in transfer, passed or failed, with no checklist or every step done, before the steps', () => {
        for (const closing of [task, failed]) {
            for (const steps of [[], done, open]) {
                expect(stagingClosureRefusal(closing, { ...unit, stage: 'in_transfer' }, steps)).toBe(inTransfer)
            }
        }
    })

    it('refuses a stale task: its unit on another line, released to stock, or sourced again under a newer task', () => {
        const otherLine = 'SN1 is no longer on the order line NSTG1 stages for: close NSTG1 skipped'
        expect(stagingClosureRefusal(task, { ...unit, lineId: 'L2' }, done)).toBe(otherLine)
        expect(stagingClosureRefusal(failed, { ...unit, lineId: 'L2' }, [])).toBe(otherLine)
        expect(stagingClosureRefusal(task, { ...unit, stage: 'available', lineId: '' }, done)).toBe(otherLine)
        expect(stagingClosureRefusal(failed, { ...unit, stage: 'available', lineId: '' }, [])).toBe(otherLine)
        expect(stagingClosureRefusal({ ...task, newerTask: 'NSTG2' }, unit, done)).toBe(
            'SN1 has a newer Staging task, NSTG2: close NSTG1 skipped and stage the unit under NSTG2',
        )
    })

    it('lets a failed close whose move was refused be retried: the unit is in staging, already off its line', () => {
        expect(stagingClosureRefusal(failed, { ...unit, lineId: '' }, open)).toBeNull()
        expect(stagingClosureRefusal(task, { ...unit, lineId: '' }, done)).not.toBeNull()
    })

    it('refuses a unit in a stage the lifecycle moves to neither result, saying so', () => {
        expect(stagingClosureRefusal(task, { ...unit, stage: 'shipped' }, done)).toBe(
            'SN1 is shipped, not in staging, so closing NSTG1 cannot move it to staged: close NSTG1 skipped if it is no longer needed',
        )
        expect(stagingClosureRefusal(failed, { ...unit, stage: 'staged' }, [])).toBe(
            'SN1 is staged, not in staging, so closing NSTG1 cannot move it to pending_evaluation: close NSTG1 skipped if it is no longer needed',
        )
        expect(stagingClosureRefusal(task, { ...unit, stage: null }, done)).toContain('in a stage this app does not model')
    })

    it('takes a task made by hand (no line) as standing for the unit on its own line', () => {
        const byHand = { ...task, lineId: '' }
        expect(stagingClosureRefusal(byHand, { ...unit, lineId: 'L9' }, done)).toBeNull()
        expect(stagingClosureRefusal(byHand, { ...unit, stage: 'in_transfer' }, done)).toBe(inTransfer)
    })

    it('refuses a closure whose asset cannot be read: it would move nothing', () => {
        expect(stagingClosureRefusal(task, null, done)).toBe('The asset of NSTG1 cannot be read: close NSTG1 skipped')
    })

    it('moves exactly the stages closing can move on to its result, failed or not', () => {
        for (const closing of [task, failed]) {
            const movable = ALL_STAGES.filter((stage) => closureMoveProblem(closing, { ...unit, stage }) === null)
            expect(movable).toEqual(closing.failed ? ['reserved', 'staging', 'pending_evaluation'] : ['reserved', 'staging', 'staged'])
            for (const stage of movable.filter((s) => s !== stageOnClosure(closing.failed))) {
                expect(stage === 'reserved' || checkTransition(stage, stageOnClosure(closing.failed), facts).allowed).toBe(true)
            }
        }
    })

    describe('skipped (or incomplete)', () => {
        const skipped: ClosingTask = { ...task, closing: 'skipped' }

        it('is refused while the unit on its open line still needs the task: in transfer or in staging', () => {
            expect(stagingClosureRefusal(skipped, { ...unit, stage: 'in_transfer' }, open)).toBe(
                'SN1 is in transfer to the staging centre for its order line, which needs NSTG1: close NSTG1 complete once the staging centre receives it',
            )
            expect(stagingClosureRefusal(skipped, unit, open)).toBe(
                'SN1 is in staging for its order line, which needs NSTG1: close NSTG1 complete, or failed to send the unit for evaluation',
            )
        })

        it("lets the app's own skips through: a cancel or rejection ends the Order first, a put-back unit leaves its line first, sourcing skips a reserved unit's task", () => {
            expect(stagingClosureRefusal(skipped, { ...unit, lineOpen: false }, open)).toBeNull()
            expect(stagingClosureRefusal(skipped, { ...unit, stage: 'in_transfer', lineOpen: false }, open)).toBeNull()
            expect(stagingClosureRefusal(skipped, { ...unit, stage: 'available', lineId: '' }, open)).toBeNull()
            expect(stagingClosureRefusal(skipped, { ...unit, stage: 'reserved' }, open)).toBeNull()
        })

        it('lets a task no longer needed be skipped: a stale one, one made by hand, one whose unit is staged or gone', () => {
            expect(stagingClosureRefusal({ ...skipped, newerTask: 'NSTG2' }, unit, open)).toBeNull()
            expect(stagingClosureRefusal(skipped, { ...unit, lineId: 'L2' }, open)).toBeNull()
            expect(stagingClosureRefusal({ ...skipped, lineId: '' }, unit, open)).toBeNull()
            expect(stagingClosureRefusal(skipped, { ...unit, stage: 'staged' }, open)).toBeNull()
            expect(stagingClosureRefusal(skipped, null, open)).toBeNull()
        })
    })
})

describe('newerTask', () => {
    const mine = { number: 'NSTG0001005', openedAt: '2026-11-01 10:00:00' }

    it('names the newest open task of the unit opened after this one', () => {
        const later = { number: 'NSTG0001010', openedAt: '2026-11-03 09:00:00' }
        const latest = { number: 'NSTG0001020', openedAt: '2026-11-04 09:00:00' }
        expect(newerTask(mine, [later, latest])).toBe('NSTG0001020')
        expect(newerTask(mine, [latest, later])).toBe('NSTG0001020')
    })

    it('is none when every other open task is older', () => {
        expect(newerTask(mine, [{ number: 'NSTG0001001', openedAt: '2026-10-30 08:00:00' }])).toBe('')
        expect(newerTask(mine, [])).toBe('')
    })

    it('takes the later number within one second, a longer number as later', () => {
        expect(newerTask(mine, [{ number: 'NSTG0001006', openedAt: mine.openedAt }])).toBe('NSTG0001006')
        expect(newerTask(mine, [{ number: 'NSTG0001004', openedAt: mine.openedAt }])).toBe('')
        expect(newerTask({ number: 'NSTG9999999', openedAt: mine.openedAt }, [{ number: 'NSTG10000000', openedAt: mine.openedAt }])).toBe('NSTG10000000')
    })
})
