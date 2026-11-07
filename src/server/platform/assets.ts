import { GlideRecord, gs } from '@servicenow/glide'
import { normalizeSerial } from '../domain/asn'
import {
    checkTransition,
    fieldsOf,
    stageOf,
    type LegalOwner,
    type Stage,
    type TransitionFacts,
    type TransitionVerdict,
    voidsWipeEvidence,
} from '../domain/lifecycle'
import { str } from './records'

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
 * also clears the wipe evidence (domain/lifecycle `voidsWipeEvidence`), so every path that stages an Asset does.
 * `force` lets administrators correct assets in stages the app does not model.
 */
export function moveAsset(asset: GlideRecord, to: Stage, options: { force?: boolean } = {}): TransitionVerdict {
    const from = readStage(asset)
    const verdict = options.force ? ({ allowed: true } as const) : checkTransition(from, to, transitionFacts(asset))
    if (verdict.allowed) {
        const fields = fieldsOf(to)
        asset.setValue('install_status', fields.installStatus)
        asset.setValue('substatus', fields.substatus ?? '')
        if (voidsWipeEvidence(from, to)) {
            asset.setValue('x_daas_ham_wiped_on', '')
            asset.setValue('x_daas_ham_wipe_certificate', '')
        }
    }
    return verdict
}

/** Move and save, logging (not throwing) when the lifecycle refuses the move. */
export function moveAndSave(asset: GlideRecord, to: Stage, context: string): boolean {
    const verdict = moveAsset(asset, to)
    if (!verdict.allowed) {
        gs.warn(`[x_daas_ham] ${context}: ${str(asset, 'serial_number')} not moved to ${to}: ${verdict.reason}`)
        return false
    }
    asset.update()
    return true
}

/** The Asset left its Site: free its Rack units (the caller saves). */
export function clearRackPlacement(asset: GlideRecord): void {
    asset.setValue('x_daas_ham_rack', '')
    asset.setValue('x_daas_ham_ru_start', '')
    asset.setValue('x_daas_ham_rack_face', '')
}

/**
 * A new, unsaved hardware Asset of `modelId` in `stage`. Sets the fields the platform treats as
 * mandatory on assets (model category, quantity), which GlideRecord inserts do not enforce.
 */
export function newAsset(modelId: string, stage: Stage): GlideRecord {
    const asset = new GlideRecord('alm_hardware')
    asset.initialize()
    asset.setValue('model', modelId)
    asset.setValue('quantity', 1)
    const model = new GlideRecord('cmdb_model')
    if (model.get(modelId)) asset.setValue('model_category', str(model, 'cmdb_model_category').split(',')[0])
    const fields = fieldsOf(stage)
    asset.setValue('install_status', fields.installStatus)
    asset.setValue('substatus', fields.substatus ?? '')
    return asset
}

/**
 * The Asset with this serial number, Provider tag or Customer tag. `beyondVisibility` skips the
 * before-query visibility rules (ADR 0005): receiving must find incoming units that belong to no
 * stockroom yet, and the device-events API must find any asset.
 */
export function findAssetByIdentifier(identifier: string, options: { beyondVisibility?: boolean } = {}): GlideRecord | null {
    const code = identifier.trim()
    if (!code) return null
    const asset = new GlideRecord('alm_hardware')
    if (options.beyondVisibility) asset.setWorkflow(false)
    const byIdentifier = asset.addQuery('serial_number', normalizeSerial(code))
    byIdentifier.addOrCondition('asset_tag', code)
    byIdentifier.addOrCondition('x_daas_ham_customer_tag', code)
    asset.setLimit(1)
    asset.query()
    // Re-enable rules so later updates of this record run asset-CI sync and the app's own rules.
    asset.setWorkflow(true)
    return asset.next() ? asset : null
}
