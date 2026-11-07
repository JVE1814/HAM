// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideDateTime, GlideRecord } from '@servicenow/glide'
import { normalizeSerial, validateAsnRows } from '../domain/asn'
import { parseLifecycleRow } from '../domain/model-lifecycle'
import { newAsset } from '../platform/assets'
import { loadNormalizationData, recordNormalizationException, resolveModel } from '../platform/normalization'
import { PROPERTY, stringProperty } from '../platform/properties'
import { str } from '../platform/records'

/** Import-set rows processed on insert (ASN, lifecycle CSV). */

function finish(row: GlideRecord, state: 'inserted' | 'updated' | 'error' | 'ignored', comment: string): void {
    row.setValue('sys_import_state', state)
    row.setValue('sys_import_state_comment', comment)
    row.update()
}

/** After-insert rule on ASN import rows: create the in-transit Asset (ASN = scan-to-confirm receiving). */
export function processAsnRow(current: GlideRecord): void {
    const serial = normalizeSerial(str(current, 'serial'))
    const [check] = validateAsnRows(
        [{ serial, pid: str(current, 'pid'), poNumber: str(current, 'po_number') }],
        serialExists(serial) ? new Set([serial]) : new Set(),
    )
    if (!check.ok) return finish(current, 'error', check.reason)

    const raw = { manufacturer: str(current, 'manufacturer'), model: str(current, 'pid') }
    const resolution = resolveModel(raw, loadNormalizationData())
    if (!resolution.modelId) {
        recordNormalizationException(raw, 'reason' in resolution ? resolution.reason : '', {
            table: 'x_daas_ham_asn_import',
            id: current.getUniqueValue(),
        })
        return finish(current, 'error', `PID ${raw.model} does not map to a model; see normalization exceptions`)
    }

    const asset = newAsset(resolution.modelId, 'in_transit')
    asset.setValue('serial_number', serial)
    asset.setValue('po_number', str(current, 'po_number'))
    asset.setValue('company', stringProperty(PROPERTY.providerCompany))
    asset.setValue('x_daas_ham_legal_owner', 'provider')
    asset.setValue('x_daas_ham_customer_tag', str(current, 'customer_tag'))
    asset.setValue('x_daas_ham_mac_address', str(current, 'mac_address'))
    asset.setValue('x_daas_ham_claim_code', str(current, 'claim_code'))
    asset.setValue('x_daas_ham_staging_source', str(current, 'staging_source') === 'distributor' ? 'distributor' : 'in_house')
    const assetId = asset.insert()
    finish(current, assetId ? 'inserted' : 'error', assetId ? `Asset ${serial} in transit` : 'Asset insert failed')
}

function serialExists(serial: string): boolean {
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('serial_number', serial)
    asset.setLimit(1)
    asset.query()
    return asset.hasNext()
}

/** After-insert rule on lifecycle import rows: upsert the Model lifecycle (source CSV). */
export function processLifecycleRow(current: GlideRecord): void {
    const parsed = parseLifecycleRow({
        pid: str(current, 'pid'),
        endOfSale: str(current, 'end_of_sale'),
        endOfSupport: str(current, 'end_of_support'),
        endOfExtendedSupport: str(current, 'end_of_extended_support'),
        endOfLife: str(current, 'end_of_life'),
    })
    if (!parsed.ok) return finish(current, 'error', parsed.reason)

    const resolution = resolveModel({ manufacturer: str(current, 'manufacturer'), model: parsed.pid }, loadNormalizationData())
    if (!resolution.modelId) return finish(current, 'error', `PID ${parsed.pid} does not map to a model`)

    const lifecycle = new GlideRecord('x_daas_ham_model_lifecycle')
    const exists = lifecycle.get('model', resolution.modelId)
    if (!exists) {
        lifecycle.initialize()
        lifecycle.setValue('model', resolution.modelId)
    }
    lifecycle.setValue('end_of_sale', parsed.dates.endOfSale ?? '')
    lifecycle.setValue('end_of_support', parsed.dates.endOfSupport ?? '')
    lifecycle.setValue('end_of_extended_support', parsed.dates.endOfExtendedSupport ?? '')
    lifecycle.setValue('end_of_life', parsed.dates.endOfLife ?? '')
    lifecycle.setValue('source', 'csv')
    lifecycle.setValue('source_reference', str(current, 'source_reference'))
    lifecycle.setValue('last_refreshed', new GlideDateTime().getValue())
    if (exists) lifecycle.update()
    else lifecycle.insert()
    finish(current, exists ? 'updated' : 'inserted', `Lifecycle for ${parsed.pid}`)
}
