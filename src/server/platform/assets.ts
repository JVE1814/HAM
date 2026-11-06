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
 * Move an Asset to `to` if the lifecycle allows it (set its fields; the caller saves the record).
 * `force` lets administrators correct assets in stages the app does not model.
 */
export function moveAsset(asset: GlideRecord, to: Stage, options: { force?: boolean } = {}): TransitionVerdict {
    const verdict = options.force ? ({ allowed: true } as const) : checkTransition(readStage(asset), to, transitionFacts(asset))
    if (verdict.allowed) {
        const fields = fieldsOf(to)
        asset.setValue('install_status', fields.installStatus)
        asset.setValue('substatus', fields.substatus ?? '')
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

/** The Asset with this serial number, Provider tag or Customer tag. */
export function findAssetByIdentifier(identifier: string): GlideRecord | null {
    const code = identifier.trim()
    if (!code) return null
    const asset = new GlideRecord('alm_hardware')
    const byIdentifier = asset.addQuery('serial_number', normalizeSerial(code))
    byIdentifier.addOrCondition('asset_tag', code)
    byIdentifier.addOrCondition('x_daas_ham_customer_tag', code)
    asset.setLimit(1)
    asset.query()
    return asset.next() ? asset : null
}
