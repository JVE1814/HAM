import { gs, type GlideRecord } from '@servicenow/glide'
import { adoptIntoFleet } from '../platform/assets.ts'
import { str } from '../platform/records.ts'

/**
 * UI action "Add to fleet" on an Asset (form button and list choice): the Asset becomes a fleet asset, which the app
 * then sources, stages, tracks and bills. It first
 * saves the form, so a Stockroom, Site or Agreement typed before clicking counts, and stops when that save is refused
 * (the platform says why).
 */
export function uiAddToFleet(current: GlideRecord): void {
    if (!current.update()) return
    const name = str(current, 'asset_tag') || str(current, 'serial_number') || str(current, 'display_name')
    const problem = adoptIntoFleet(current, name)
    if (problem) return void gs.addErrorMessage(`${name} not added to the fleet: ${problem}`)
    gs.addInfoMessage(`${name} added to the fleet`)
}
