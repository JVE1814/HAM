import { GlideRecord } from '@servicenow/glide'
import { ambiguousIdentifier, fieldMatch, IDENTIFIER_FIELDS, IDENTIFIER_READ_LIMIT } from '../domain/asset-identifier.ts'
import { FLEET_CONDITION, FLEET_FIELD } from '../domain/fleet.ts'
import { normalizeSerial } from '../domain/serials.ts'
import { isFleetAsset } from './assets.ts'
import { beyondVisibility } from './beyond-visibility.ts'
import { log } from './log.ts'
import type { ReadOptions } from './records.ts'

/** What an identifier names: the one Asset, none, or more than one (refused, saying why). */
export type AssetIdentified = { asset: GlideRecord } | { ambiguous: string } | null

interface IdentifierLookup {
    fleetOnly: boolean
    beyondVisibility: boolean
}

const ARRIVING: IdentifierLookup = { fleetOnly: false, beyondVisibility: true }

/**
 * The fleet asset (ADR 0016) this identifier names: by serial number, else Provider tag, else Customer tag;
 * `{ ambiguous }`, saying why, when two Assets carry it in the first of those fields that any does,
 * as two Customers may give their switches one Customer tag; null when none carries it. `beyondVisibility` reads past
 * the app's before-query visibility rules (ADR 0005): the device-events API must find any
 * fleet asset (it reports another identifier unknown). Its later saves run every rule.
 */
export function identifyAsset(identifier: string, options: ReadOptions = {}): AssetIdentified {
    return identify(identifier, { fleetOnly: true, beyondVisibility: !!options.beyondVisibility })
}

/**
 * The fleet asset this identifier names, or null when none does or it is ambiguous (logged), for a
 * caller that reports both as an unknown identifier.
 */
export function findAssetByIdentifier(identifier: string, options: ReadOptions = {}): GlideRecord | null {
    const identified = identifyAsset(identifier, options)
    if (identified && 'ambiguous' in identified) {
        log.warn(`Identifier ${identifier.trim()} refused: ${identified.ambiguous}`)
        return null
    }
    return identified?.asset ?? null
}

/**
 * Any Asset a scanned `code` names as `identifyAsset` reads it, the Provider IT's too (ADR 0016), a fleet asset chosen
 * over one of the Provider IT's that carries the same code, read past the app's visibility rules (ADR 0005): an
 * arriving unit belongs to no stockroom yet. What a receipt looks a scanned unit up by, and checks again under the
 * serial's lock just as it was looked up before it, so a serial never has two Assets and a serial IT holds is refused
 * rather than given a second Asset.
 */
export function identifyAnyAsset(code: string): AssetIdentified {
    return identify(code, ARRIVING)
}

/**
 * Any Asset with the serial number `serial`, the Provider IT's too, a fleet asset first, read past the app's visibility
 * rules: what an ASN row's serial column duplicates (an Asset whose tag happens to read the same is another unit), and
 * what the row's holder of the serial's lock checks before it creates the Asset.
 */
export function findAnyAssetBySerial(serial: string): GlideRecord | null {
    const code = serial.trim()
    if (!code) return null
    return assetsCarrying('serial_number', normalizeSerial(code), ARRIVING)[0]?.record() ?? null
}

function identify(identifier: string, lookup: IdentifierLookup): AssetIdentified {
    const code = identifier.trim()
    if (!code) return null
    for (const field of IDENTIFIER_FIELDS) {
        const found = assetsCarrying(field.field, normalizeSerial(code), lookup)
        const match = fieldMatch(found.map((asset) => asset.fleet))
        if (match.kind === 'ambiguous') return { ambiguous: ambiguousIdentifier(code, field) }
        if (match.kind === 'none') continue
        const asset = found[match.index]?.record()
        return asset ? { asset } : null
    }
    return null
}

interface Carrier {
    fleet: boolean
    record: () => GlideRecord | null
}

function assetsCarrying(field: string, value: string, lookup: IdentifierLookup): Carrier[] {
    const read = (record: GlideRecord, run: () => boolean | void) => (lookup.beyondVisibility ? beyondVisibility(record, run) : run())
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery(field, value)
    if (lookup.fleetOnly) asset.addEncodedQuery(FLEET_CONDITION)
    else asset.orderByDesc(FLEET_FIELD)
    asset.setLimit(IDENTIFIER_READ_LIMIT)
    read(asset, () => asset.query())
    if (!asset.next()) return []
    const first = { fleet: isFleetAsset(asset), id: asset.getUniqueValue() }
    if (!asset.hasNext()) return [{ fleet: first.fleet, record: () => asset }]
    asset.next()
    const again = new GlideRecord('alm_hardware')
    const reread = () => (read(again, () => again.get(first.id)) ? again : null)
    return [{ fleet: first.fleet, record: reread }, { fleet: isFleetAsset(asset), record: () => asset }]
}
