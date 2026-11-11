import { runClaims } from '../platform/claim-steps.ts'

/** OEM claim and provisioning: staging steps the manufacturer's cloud does (P3.27, D70). */

export function runOemClaims(): void {
    runClaims()
}
