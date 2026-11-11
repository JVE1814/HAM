import { GlideRecord } from '@servicenow/glide'
import { ambiguousIdentifier, fieldMatch, IDENTIFIER_FIELDS, IDENTIFIER_READ_LIMIT } from '../domain/asset-identifier.ts'
import { normalizeSerial } from '../domain/serials.ts'
import {
    adoptionProblem,
    FLEET_FIELD,
    fleetCondition,
    OEM_PID_FIELD,
    STOCKROOM_TYPE_FIELD,
    type FleetCandidate,
} from '../domain/fleet.ts'
import {
    checkTransition,
    fieldsOf,
    stageOf,
    type Stage,
    type TransitionFacts,
    type TransitionVerdict,
    voidsWipeEvidence,
} from '../domain/lifecycle.ts'
import { PLACEMENT_FIELDS } from '../domain/rack.ts'
import { LEGAL_OWNER, type LegalOwner } from '../domain/vocabulary.ts'
import { beyondVisibility } from './beyond-visibility.ts'
import { stringProperty } from './properties.ts'
import { PROPERTY } from '../domain/properties.ts'
import { bool, refusal, str, warnRefused, type ForeignRecord, type ReadOptions } from './records.ts'
import { log } from './log.ts'

/** Reading and moving Assets (alm_hardware) through their Lifecycle stage (ADR 0002). */

export function readStage(asset: ForeignRecord): Stage | null {
    return stageOf({ installStatus: str(asset, 'install_status'), substatus: str(asset, 'substatus') })
}

export function transitionFacts(asset: ForeignRecord): TransitionFacts {
    return {
        hasSite: !!str(asset, 'x_daas_ham_site'),
        hasAgreement: !!str(asset, 'x_daas_ham_agreement'),
        legalOwner: str(asset, 'x_daas_ham_legal_owner') as LegalOwner | '',
        wipeEvidenceComplete: !!str(asset, 'x_daas_ham_wiped_on') && !!str(asset, 'x_daas_ham_wipe_certificate'),
    }
}

/**
 * Move an Asset to `to` if the lifecycle allows it (set its fields; the caller saves the record). A move into staging
 * also clears the wipe evidence (domain/lifecycle `voidsWipeEvidence`); a save that sets the stage some other way has
 * it cleared by a before-update rule (entry/assets `clearVoidedWipeEvidence`).
 */
export function moveAsset(asset: ForeignRecord, to: Stage): TransitionVerdict {
    const from = readStage(asset)
    const verdict = checkTransition(from, to, transitionFacts(asset))
    if (verdict.allowed) {
        writeStage(asset, to)
        if (voidsWipeEvidence(from, to)) clearWipeEvidence(asset)
    }
    return verdict
}

function writeStage(asset: ForeignRecord, stage: Stage): void {
    const fields = fieldsOf(stage)
    asset.setValue('install_status', fields.installStatus)
    asset.setValue('substatus', fields.substatus ?? '')
}

/** Clear the Asset's wipe evidence (the caller saves): a wipe recorded before no longer covers the unit. */
export function clearWipeEvidence(asset: ForeignRecord): void {
    asset.setValue('x_daas_ham_wiped_on', '')
    asset.setValue('x_daas_ham_wipe_certificate', '')
}

/**
 * Move the Asset to `to` and save it; why it was not moved ('' once saved): the lifecycle's reason for a move it
 * refuses, the platform's for a save it refuses. Nothing is logged: the caller puts the reason where it belongs (on a
 * line, in the log, before the user). A refused record keeps the unsaved move: it is not re-read, as it may be a
 * query's cursor or found past the before-query rules.
 */
export function moveRefusal(asset: GlideRecord, to: Stage): string {
    const verdict = moveAsset(asset, to)
    if (!verdict.allowed) return verdict.reason
    return asset.update() ? '' : refusal(asset, `the asset could not be saved as ${to}`)
}

/**
 * Move and save (`moveRefusal`); false (and a warning, not a throw) when the lifecycle or the platform refuses, so the
 * caller stops before work that needs the move.
 */
export function moveAndSave(asset: GlideRecord, to: Stage, context: string): boolean {
    const reason = moveRefusal(asset, to)
    if (!reason) return true
    log.warn(`${context}: ${str(asset, 'serial_number')} not moved to ${to}: ${reason}`)
    return false
}

/** The Asset left its Site: free its Rack units (the caller saves). */
export function clearRackPlacement(asset: GlideRecord): void {
    for (const field of Object.values(PLACEMENT_FIELDS)) asset.setValue(field, '')
}

/**
 * A new, unsaved hardware Asset of `modelId` in `stage`: a fleet asset (ADR 0016) the Provider owns until a lease or a
 * Customer says otherwise, as the columns stamp no default on the rows the Provider's IT creates, and the Provider's
 * own stock (its company, ADR 0006) until a caller holds it for a Customer. Sets the fields the platform treats as
 * mandatory on assets (model category, quantity), which GlideRecord inserts do not enforce. Every Asset the app
 * creates is made here.
 */
export function newAsset(modelId: string, stage: Stage): GlideRecord {
    const asset = new GlideRecord('alm_hardware')
    asset.initialize()
    asset.setValue(FLEET_FIELD, true)
    asset.setValue('x_daas_ham_legal_owner', LEGAL_OWNER.provider)
    asset.setValue('company', stringProperty(PROPERTY.providerCompany))
    asset.setValue('model', modelId)
    asset.setValue('quantity', 1)
    const model = new GlideRecord('cmdb_model')
    if (model.get(modelId)) asset.setValue('model_category', str(model, 'cmdb_model_category').split(',')[0])
    writeStage(asset, stage)
    return asset
}

/** Whether the Asset is a fleet asset (ADR 0016). */
export function isFleetAsset(asset: ForeignRecord): boolean {
    return bool(asset, FLEET_FIELD)
}

/**
 * Make the Asset a fleet asset (the caller saves): adopted by "Add to fleet", or taken in by a receipt. A blank Legal
 * owner becomes the Provider, as on the Assets the app creates (`newAsset`); one already set is kept.
 */
export function joinFleet(asset: GlideRecord): void {
    asset.setValue(FLEET_FIELD, true)
    if (!str(asset, 'x_daas_ham_legal_owner')) asset.setValue('x_daas_ham_legal_owner', LEGAL_OWNER.provider)
}

/**
 * Adopt equipment the Provider already has into the fleet ("Add to fleet") and save it, when domain/fleet
 * `adoptionProblem` allows it; why it was not adopted ('' once saved): that problem, or the platform's reason for the
 * save it refused, logged with the Asset named as `name`. alm_hardware is a global table, but what the platform refuses
 * from this scope is a rule's setAbortAction, not a save: the Asset is saved as any script saves one.
 */
export function adoptIntoFleet(asset: GlideRecord, name: string): string {
    const problem = adoptionProblem(fleetCandidate(asset))
    if (problem) return problem
    joinFleet(asset)
    return asset.update() ? '' : warnRefused(asset, `${name} not added to the fleet`)
}

export function fleetCandidate(asset: GlideRecord): FleetCandidate {
    const { hasSite, hasAgreement } = transitionFacts(asset)
    return {
        fleet: isFleetAsset(asset),
        stage: readStage(asset),
        modelPid: str(asset, `model.${OEM_PID_FIELD}`),
        stockroomType: str(asset, `stockroom.${STOCKROOM_TYPE_FIELD}`),
        hasSite,
        hasAgreement,
    }
}

/** What an identifier names (`identifyAsset`): the one Asset, none, or more than one (refused, saying why). */
export type AssetIdentified = { asset: GlideRecord } | { ambiguous: string } | null

interface IdentifierLookup {
    fleetOnly: boolean
    beyondVisibility: boolean
}

const ARRIVING: IdentifierLookup = { fleetOnly: false, beyondVisibility: true }

/**
 * The fleet asset (ADR 0016) this identifier names: by serial number, else Provider tag, else Customer tag (domain/
 * asset-identifier); `{ ambiguous }`, saying why, when two Assets carry it in the first of those fields that any does,
 * as two Customers may give their switches one Customer tag; null when none carries it. `beyondVisibility` reads past
 * the app's before-query visibility rules (ADR 0005, platform/beyond-visibility): the device-events API must find any
 * fleet asset (it reports another identifier unknown). Its later saves run every rule.
 */
export function identifyAsset(identifier: string, options: ReadOptions = {}): AssetIdentified {
    return identify(identifier, { fleetOnly: true, beyondVisibility: !!options.beyondVisibility })
}

/**
 * The fleet asset this identifier names (`identifyAsset`), or null when none does or it is ambiguous (logged), for a
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
        const value = field.field === 'serial_number' ? normalizeSerial(code) : code
        const found = assetsCarrying(field.field, value, lookup)
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
    if (lookup.fleetOnly) asset.addEncodedQuery(fleetCondition())
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
