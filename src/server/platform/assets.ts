import { GlideRecord } from '@servicenow/glide'
import {
    adoptionProblem,
    FLEET_FIELD,
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
import { MODEL_TABLE } from '../domain/normalization.ts'
import { LEGAL_OWNER, type LegalOwner } from '../domain/vocabulary.ts'
import { stringProperty } from './properties.ts'
import { PROPERTY } from '../domain/properties.ts'
import { bool, refusal, str, warnRefused, type ForeignRecord } from './records.ts'
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
 * also clears the wipe evidence; a save that sets the stage some other way has
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
 * False (and a warning, not a throw) when the lifecycle or the platform refuses, so the
 * caller stops before work that needs the move.
 */
export function moveAndSave(asset: GlideRecord, to: Stage, context: string): boolean {
    const reason = moveRefusal(asset, to)
    if (!reason) return true
    log.warn(`${context}: ${str(asset, 'serial_number')} not moved to ${to}: ${reason}`)
    return false
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
    const model = new GlideRecord(MODEL_TABLE)
    if (model.get(modelId)) asset.setValue('model_category', str(model, 'cmdb_model_category').split(',')[0])
    writeStage(asset, stage)
    return asset
}

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
