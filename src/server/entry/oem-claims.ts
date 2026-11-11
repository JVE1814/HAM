// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { gs } from '@servicenow/glide'
import { CLAIM_VENDORS, runVendorClaims, type ClaimStore } from '../domain/oem/claims.ts'
import { glideClaimStore, releaseStranded } from '../platform/claim-steps.ts'
import { withLock, type HeldLock } from '../platform/locks.ts'
import { restMessagePort } from '../platform/rest-port.ts'
import { boolProperty, intProperty, PROPERTY } from '../platform/properties.ts'

/** OEM claim and provisioning: staging steps the manufacturer's cloud does (plan §13 OEM claim adapters, Q70). */

/**
 * The job lock (ADR 0013) a claim run holds throughout. Two runs at once (the 5-minute job and an *Execute now*) would
 * load the same due steps and send each to its vendor twice, spending two runs' calls in one rate-limit window (Meraki
 * allows 10 calls in 5 minutes), and the second claim of a device already claimed fails, marking a step the first run
 * ticked done failed again.
 */
const RUN_LOCK = 'oem_claim_run'

/**
 * Every 5 minutes: for each enabled vendor, send its pending (and stale failed) automated staging steps through the
 * vendor's adapters within `x_daas_ham.oem.claim.max_calls` calls per run, holding the run lock. A run that finds it
 * held sends nothing and leaves the steps to the run holding it. A run that outlasts the lock (ADR 0013) sends nothing
 * more once it has lost it, checked before every call (runVendorClaims): it saves what its calls so far returned,
 * leaves the steps it did not send to the run that took the lock over, and that run goes on.
 */
export function runOemClaims(): void {
    if (withLock(RUN_LOCK, runHolding)) return
    gs.info(`[x_daas_ham] OEM claims not sent: another run holds the ${RUN_LOCK} lock and sends them`)
}

function runHolding(lock: HeldLock): void {
    const maxCalls = intProperty(PROPERTY.claimMaxCalls, 8)
    releaseStranded()
    const store = whileHeld(lock, glideClaimStore())
    for (const vendor of CLAIM_VENDORS) {
        if (boolProperty(`x_daas_ham.oem.claim.${vendor}.enabled`, false)) runVendorClaims(vendor, store, restMessagePort, maxCalls, () => lock.held())
    }
}

/** `store`, finding no step due once `lock` is lost (logged once), so the run calls no vendor after that. */
function whileHeld(lock: HeldLock, store: ClaimStore): ClaimStore {
    let lost = false
    return {
        due: (vendor, action, limit) => {
            if (!lost && !lock.held()) {
                lost = true
                gs.warn(`[x_daas_ham] OEM claim run stopped: job lock lost while sending, to the run that took it over`)
            }
            return lost ? [] : store.due(vendor, action, limit)
        },
        settle: store.settle,
    }
}
