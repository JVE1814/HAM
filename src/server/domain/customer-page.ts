import { fleetStagesQuery } from './fleet.ts'
import { DEPLOYED_STAGES } from './lifecycle.ts'

/** What the customer self-service page lists (P2.9, D49). */

/**
 * The equipment the customer page lists, as an encoded alm_hardware query: the fleet assets (ADR 0016) shipped to a
 * Site, serving there or awaiting return. The Fleet flag tells them from the Provider IT's hardware, laptops in use
 * included, whatever their Agreement: a deployed fleet unit missing its Agreement (a data gap) is still its Customer's
 * equipment. `visible` (the reader's `visibilityFilter` on alm_hardware, null for staff who see every Customer) is put
 * into every stage's clause: the before-query rule's filter would bind to the last clause only (ADR 0005).
 */
export function customerEquipmentQuery(visible: string | null): string {
    return fleetStagesQuery(DEPLOYED_STAGES, visible ?? '')
}
