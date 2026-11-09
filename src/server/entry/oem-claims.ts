import { runClaims } from '../platform/claim-steps.ts'

/** OEM claim and provisioning: staging steps the manufacturer's cloud does (P3.27, D70). */

/** Every 5 minutes: send each enabled vendor's due automated staging steps to its cloud (platform/claim-steps `runClaims`). */
export function runOemClaims(): void {
    runClaims()
}
