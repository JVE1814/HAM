import { CLAIM_VENDORS, runVendorClaims } from '../domain/oem/claims.ts'
import { glideClaimStore } from '../platform/claim-steps.ts'
import { restMessagePort } from '../platform/rest-port.ts'
import { boolProperty, intProperty, PROPERTY } from '../platform/properties.ts'

/** OEM claim and provisioning: staging steps the manufacturer's cloud does (P3.27, D70). */

/**
 * Every 5 minutes: for each enabled vendor, send its pending (and stale failed) automated staging
 * steps through the vendor's adapters within `x_daas_ham.oem.claim.max_calls` calls per run.
 */
export function runOemClaims(): void {
    const maxCalls = intProperty(PROPERTY.claimMaxCalls, 8)
    const store = glideClaimStore()
    for (const vendor of CLAIM_VENDORS) {
        if (boolProperty(`x_daas_ham.oem.claim.${vendor}.enabled`, false)) runVendorClaims(vendor, store, restMessagePort, maxCalls)
    }
}
