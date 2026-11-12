import { describe, expect, it } from 'vitest'
import { MAX_LISTED_DEVICES } from '../../server/domain/customer-requests'
import type { AttestationAnswers } from '../../server/domain/rest-contracts'
import { attestationBatches } from './attestation-batches'

const answers = (count: number): AttestationAnswers['items'] =>
    Array.from({ length: count }, (_, i) => ({ id: `item${i}`, response: 'confirmed' }))

describe('attestationBatches', () => {
    it.each([0, 1, MAX_LISTED_DEVICES])('sends %i answers in one request that submits', (count) => {
        expect(attestationBatches(answers(count))).toEqual({ saving: [], submitting: answers(count) })
    })

    it('sends a long attestation in requests the server accepts, submitting only with the last', () => {
        const all = answers(2 * MAX_LISTED_DEVICES + 1)
        const { saving, submitting } = attestationBatches(all)
        expect([...saving, submitting].map((batch) => batch.length)).toEqual([MAX_LISTED_DEVICES, MAX_LISTED_DEVICES, 1])
        expect([...saving, submitting].flat()).toEqual(all)
    })

    it('submits with the last full batch when the answers fill whole batches', () => {
        const { saving, submitting } = attestationBatches(answers(2 * MAX_LISTED_DEVICES))
        expect([...saving, submitting].map((batch) => batch.length)).toEqual([MAX_LISTED_DEVICES, MAX_LISTED_DEVICES])
    })
})
