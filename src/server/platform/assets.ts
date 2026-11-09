import { GlideRecord, gs } from '@servicenow/glide'
import { normalizeSerial } from '../domain/asn.ts'
import { FLEET_FIELD, fleetCondition, OEM_PID_FIELD, STOCKROOM_TYPE_FIELD, type FleetCandidate } from '../domain/fleet.ts'
import {
    checkTransition,
    fieldsOf,
    stageOf,
    type Stage,
    type TransitionFacts,
    type TransitionVerdict,
    voidsWipeEvidence,
} from '../domain/lifecycle.ts'
import type { LegalOwner } from '../domain/vocabulary.ts'
import { beyondVisibility } from './beyond-visibility.ts'
import { PROPERTY, stringProperty } from './properties.ts'
import { bool, refusal, str, type ReadOptions } from './records.ts'

/** Reading and moving Assets (alm_hardware) through their Lifecycle stage (ADR 0002). */

export function readStage(asset: GlideRecord): Stage | null {
    return stageOf({ installStatus: str(asset, 'install_status'), substatus: str(asset, 'substatus') })
}

export function transitionFacts(asset: GlideRecord): TransitionFacts {
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
export function moveAsset(asset: GlideRecord, to: Stage): TransitionVerdict {
    const from = readStage(asset)
    const verdict = checkTransition(from, to, transitionFacts(asset))
    if (verdict.allowed) {
        writeStage(asset, to)
        if (voidsWipeEvidence(from, to)) clearWipeEvidence(asset)
    }
    return verdict
}

function writeStage(asset: GlideRecord, stage: Stage): void {
    const fields = fieldsOf(stage)
    asset.setValue('install_status', fields.installStatus)
    asset.setValue('substatus', fields.substatus ?? '')
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
 * Customer says otherwise, as the columns stamp no default on the rows the Provider's IT creates, and the Provider's
 * own stock (its company, ADR 0006) until a caller holds it for a Customer. Sets the fields the platform treats as
 * mandatory on assets (model category, quantity), which GlideRecord inserts do not enforce. Every Asset the app
 * creates is made here.
 */
export function newAsset(modelId: string, stage: Stage): GlideRecord {
    const asset = new GlideRecord('alm_hardware')
    asset.initialize()
    asset.setValue(FLEET_FIELD, true)
    asset.setValue('x_daas_ham_legal_owner', 'provider')
    asset.setValue('company', stringProperty(PROPERTY.providerCompany))
    asset.setValue('model', modelId)
    asset.setValue('quantity', 1)
    const model = new GlideRecord('cmdb_model')
    if (model.get(modelId)) asset.setValue('model_category', str(model, 'cmdb_model_category').split(',')[0])
    writeStage(asset, stage)
    return asset
}

/** Whether the Asset is a fleet asset (ADR 0016). */
export function isFleetAsset(asset: GlideRecord): boolean {
    return bool(asset, FLEET_FIELD)
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

/**
 * The fleet asset (ADR 0016) with this serial number, Provider tag or Customer tag. `beyondVisibility` reads it past
 * the app's before-query visibility rules (ADR 0005, platform/beyond-visibility): the device-events API must find any
 * fleet asset (it reports another identifier unknown). Its later saves run every rule.
 */
export function findAssetByIdentifier(identifier: string, options: ReadOptions = {}): GlideRecord | null {
    return findByCode(identifier, { match: 'identifier', fleetOnly: true, beyondVisibility: !!options.beyondVisibility })
}

/**
 * Any Asset that carries `code`, the Provider IT's too (ADR 0016), a fleet asset first when both do, read past the
 * app's visibility rules (ADR 0005): an arriving unit belongs to no stockroom yet. What a receipt looks a scanned unit
 * up by, and what both holders of a serial's lock check there before they create its Asset, so a serial never has two
 * and a serial IT holds is refused rather than given a second Asset. They match differently, each as its input reads:
 * - `identifier`: a scanned code, which names a unit by its serial number, Provider tag or Customer tag, and is checked
 *   again under the lock just as it was looked up before it;
 * - `serial`: an ASN row's serial column, which only another Asset's serial number duplicates (an Asset whose tag
 *   happens to read the same is another unit).
 */
export function findAnyAsset(code: string, match: 'identifier' | 'serial'): GlideRecord | null {
    return findByCode(code, { match, fleetOnly: false, beyondVisibility: true })
}

function findByCode(
    identifier: string,
    options: { match: 'identifier' | 'serial'; fleetOnly: boolean; beyondVisibility: boolean },
): GlideRecord | null {
    const code = identifier.trim()
    if (!code) return null
    const asset = new GlideRecord('alm_hardware')
    const byIdentifier = asset.addQuery('serial_number', normalizeSerial(code))
    if (options.match === 'identifier') {
        byIdentifier.addOrCondition('asset_tag', code)
        byIdentifier.addOrCondition('x_daas_ham_customer_tag', code)
    }
    if (options.fleetOnly) asset.addEncodedQuery(fleetCondition())
    else asset.orderByDesc(FLEET_FIELD)
    asset.setLimit(1)
    if (options.beyondVisibility) beyondVisibility(asset, () => asset.query())
    else asset.query()
    return asset.next() ? asset : null
}
