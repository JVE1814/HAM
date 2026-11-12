import { MAX_LISTED_DEVICES } from '../../server/domain/customer-requests'
import type { AttestationAnswers } from '../../server/domain/rest-contracts'

type Answers = AttestationAnswers['items']

/** An attestation's answers cut into requests the server accepts: the ones that only save, then the one that submits. */
export function attestationBatches(items: Answers): { saving: Answers[]; submitting: Answers } {
    const saving: Answers[] = []
    let at = 0
    while (items.length - at > MAX_LISTED_DEVICES) {
        saving.push(items.slice(at, at + MAX_LISTED_DEVICES))
        at += MAX_LISTED_DEVICES
    }
    return { saving, submitting: items.slice(at) }
}
