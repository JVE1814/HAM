import { runClaims } from '../platform/claim-steps.ts'

/** OEM claim and provisioning: staging steps the manufacturer's cloud does (plan §13 OEM claim adapters, Q70). */

export function runOemClaims(): void {
    runClaims()
}
