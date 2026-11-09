import { GlideRecord, gs } from '@servicenow/glide'
import { normalizeSerial } from '../domain/asn.ts'
import { ambiguousIdentifier, fieldMatch, IDENTIFIER_FIELDS, IDENTIFIER_READ_LIMIT } from '../domain/asset-identifier.ts'
import { FLEET_FIELD, fleetCondition, fleetField, OEM_PID_FIELD, STOCKROOM_TYPE_FIELD, type FleetCandidate } from '../domain/fleet.ts'
import {
    checkTransition,
    fieldsOf,
    stageOf,
    type LegalOwner,
    type Stage,
    type TransitionFacts,
    type TransitionVerdict,
    voidsWipeEvidence,
} from '../domain/lifecycle.ts'
import { beyondVisibility } from './beyond-visibility.ts'
import { bool, refusal, str } from './records.ts'

/** Reading and moving Assets (alm_hardware) through their Lifecycle stage (ADR 0002). */

export function readStage(asset: GlideRecord): Stage | null {
    return stageOf({ installStatus: str(asset, 'install_status'), substatus: str(asset, 'substatus') })
}

export function transitionFacts(asset: GlideRecord): TransitionFacts {
    return {
        hasSite: !!str(asset, 'x_daas_ham_site'),
        hasAgreement: !!str(asset, 'x_daas_ham_agreement'),
        legalOwner: str(asset, 'x_daas_ham_legal_owner') as LegalOwner,
        wipeEvidenceComplete: !!str(asset, 'x_daas_ham_wiped_on') && !!str(asset, 'x_daas_ham_wipe_certificate'),
    }
}

/**
 * Move an Asset to `to` if the lifecycle allows it (set its fields; the caller saves the record). A move into staging
 * also clears the wipe evidence (domain/lifecycle `voidsWipeEvidence`); a save that sets the stage some other way has
 * it cleared by a before-update rule (entry/assets `clearVoidedWipeEvidence`). `force` lets administrators correct
 * assets in stages the app does not model.
 */
export function moveAsset(asset: GlideRecord, to: Stage, options: { force?: boolean } = {}): TransitionVerdict {
    const from = readStage(asset)
    const verdict = options.force ? ({ allowed: true } as const) : checkTransition(from, to, transitionFacts(asset))
    if (verdict.allowed) {
        const fields = fieldsOf(to)
        asset.setValue('install_status', fields.installStatus)
        asset.setValue('substatus', fields.substatus ?? '')
        if (voidsWipeEvidence(from, to)) clearWipeEvidence(asset)
    }
    return verdict
}

/** Clear the Asset's wipe evidence (the caller saves): a wipe recorded before no longer covers the unit. */
export function clearWipeEvidence(asset: GlideRecord): void {
    asset.setValue('x_daas_ham_wiped_on', '')
    asset.setValue('x_daas_ham_wipe_certificate', '')
}

/**
 * Move and save; false (and a warning, not a throw) when the lifecycle or the platform refuses, so the caller stops
 * before work that needs the move. A refused record keeps the unsaved move: it is not re-read, as it may be a query's
 * cursor or found past the before-query rules.
 */
export function moveAndSave(asset: GlideRecord, to: Stage, context: string): boolean {
    const verdict = moveAsset(asset, to)
    if (verdict.allowed && asset.update()) return true
    const reason = verdict.allowed ? refusal(asset) : verdict.reason
    gs.warn(`[x_daas_ham] ${context}: ${str(asset, 'serial_number')} not moved to ${to}: ${reason}`)
    return false
}

/** The Asset left its Site: free its Rack units (the caller saves). */
export function clearRackPlacement(asset: GlideRecord): void {
    asset.setValue('x_daas_ham_rack', '')
    asset.setValue('x_daas_ham_ru_start', '')
    asset.setValue('x_daas_ham_rack_face', '')
}

/**
 * A new, unsaved hardware Asset of `modelId` in `stage`: a fleet asset (ADR 0016) the Provider owns until a lease or a
 * Customer says otherwise, as the columns stamp no default on the rows the Provider's IT creates. Sets the fields the
 * platform treats as mandatory on assets (model category, quantity), which GlideRecord inserts do not enforce. Every
 * Asset the app creates is made here.
 */
export function newAsset(modelId: string, stage: Stage): GlideRecord {
    const asset = new GlideRecord('alm_hardware')
    asset.initialize()
    asset.setValue(FLEET_FIELD, true)
    asset.setValue('x_daas_ham_legal_owner', 'provider')
    asset.setValue('model', modelId)
    asset.setValue('quantity', 1)
    const model = new GlideRecord('cmdb_model')
    if (model.get(modelId)) asset.setValue('model_category', str(model, 'cmdb_model_category').split(',')[0])
    const fields = fieldsOf(stage)
    asset.setValue('install_status', fields.installStatus)
    asset.setValue('substatus', fields.substatus ?? '')
    return asset
}

/** Whether the Asset (or the one `via` dot-walks to, e.g. `asset.`) is a fleet asset (ADR 0016). */
export function isFleetAsset(record: GlideRecord, via = ''): boolean {
    return bool(record, fleetField(via))
}

/**
 * Make the Asset a fleet asset (the caller saves): adopted by "Add to fleet", or taken in by a receipt. A blank Legal
 * owner becomes the Provider, as on the Assets the app creates (`newAsset`); one already set is kept.
 */
export function joinFleet(asset: GlideRecord): void {
    asset.setValue(FLEET_FIELD, true)
    if (!str(asset, 'x_daas_ham_legal_owner')) asset.setValue('x_daas_ham_legal_owner', 'provider')
}

/** The Asset as domain/fleet `adoptionProblem` and `receiptProblem` judge it. */
export function fleetCandidate(asset: GlideRecord): FleetCandidate {
    return {
        fleet: isFleetAsset(asset),
        stage: readStage(asset),
        modelPid: str(asset, `model.${OEM_PID_FIELD}`),
        stockroomType: str(asset, `stockroom.${STOCKROOM_TYPE_FIELD}`),
        hasSite: !!str(asset, 'x_daas_ham_site'),
        hasAgreement: !!str(asset, 'x_daas_ham_agreement'),
    }
}

/** What an identifier names (platform/assets `identifyAsset`): the one Asset, none, or more than one (refused). */
export type AssetIdentified = { asset: GlideRecord } | { ambiguous: string } | null

/** Options of an identifier lookup (`identifyAsset`). */
export interface IdentifierLookup {
    beyondVisibility?: boolean
    includeNonFleet?: boolean
}

/**
 * The fleet asset (ADR 0016) this identifier names: by serial number, else Provider tag, else Customer tag (domain/
 * asset-identifier); `{ ambiguous }`, saying why, when two Assets carry it in the first of those fields that any does,
 * as two Customers may give their switches one Customer tag; null when none carries it. `beyondVisibility` reads past
 * the app's before-query visibility rules (ADR 0005, platform/beyond-visibility): receiving must find incoming units
 * that belong to no stockroom yet, and the device-events API must find any fleet asset (it reports another identifier
 * unknown). Its later saves run every rule. `includeNonFleet` finds the Provider IT's Assets too, a fleet asset first
 * when both carry the identifier: for a receipt, which takes in a unit Procurement created on order and must not
 * create a second Asset for a serial IT holds.
 */
export function identifyAsset(identifier: string, options: IdentifierLookup = {}): AssetIdentified {
    const code = identifier.trim()
    if (!code) return null
    for (const field of IDENTIFIER_FIELDS) {
        const value = field.field === 'serial_number' ? normalizeSerial(code) : code
        const found = assetsCarrying(field.field, value, options)
        const match = fieldMatch(found.map((asset) => asset.fleet))
        if (match.kind === 'ambiguous') return { ambiguous: ambiguousIdentifier(code, field) }
        if (match.kind === 'none') continue
        const asset = found[match.index].record()
        return asset ? { asset } : null
    }
    return null
}

/**
 * The fleet asset this identifier names (`identifyAsset`), or null when none does or it is ambiguous (logged), for a
 * caller that reports both as an unknown identifier.
 */
export function findAssetByIdentifier(identifier: string, options: IdentifierLookup = {}): GlideRecord | null {
    const identified = identifyAsset(identifier, options)
    if (identified && 'ambiguous' in identified) {
        gs.warn(`[x_daas_ham] Identifier ${identifier.trim()} refused: ${identified.ambiguous}`)
        return null
    }
    return identified?.asset ?? null
}

/** One Asset carrying an identifier: whether it is a fleet asset, and the record itself (null once it is gone). */
interface Carrier {
    fleet: boolean
    record: () => GlideRecord | null
}

/**
 * The Assets (at most IDENTIFIER_READ_LIMIT) whose `field` is `value`: fleet assets only, or fleet ones first with
 * `includeNonFleet`. The query's own record is handed back while it is still on the first one; only when a second
 * one is read past it is the first read again, by sys_id, the same way (past the visibility rules or not).
 */
function assetsCarrying(field: string, value: string, options: IdentifierLookup): Carrier[] {
    const read = (record: GlideRecord, run: () => boolean | void) => (options.beyondVisibility ? beyondVisibility(record, run) : run())
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery(field, value)
    if (options.includeNonFleet) asset.orderByDesc(FLEET_FIELD)
    else asset.addEncodedQuery(fleetCondition())
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
