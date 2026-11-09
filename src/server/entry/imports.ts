// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideDateTime, GlideRecord, gs } from '@servicenow/glide'
import { normalizeSerial, receiveSerialLockName, validateAsnRows, type AsnRowCheck } from '../domain/asn.ts'
import { parseLifecycleRow } from '../domain/model-lifecycle.ts'
import { newAsset } from '../platform/assets.ts'
import { withLockTries, type HeldLock } from '../platform/locks.ts'
import { loadNormalizationData, recordNormalizationException, resolveModel } from '../platform/normalization.ts'
import { PROPERTY, stringProperty } from '../platform/properties.ts'
import { refusal, str } from '../platform/records.ts'

/** Import-set rows processed on insert (ASN, lifecycle CSV). */

type ImportState = 'inserted' | 'updated' | 'error' | 'ignored'

/** How a row ends: the import state and comment it is saved with. */
interface RowOutcome {
    state: ImportState
    comment: string
}

function finish(row: GlideRecord, state: ImportState, comment: string): void {
    row.setValue('sys_import_state', state)
    row.setValue('sys_import_state_comment', comment)
    row.update()
}

/** Tries at a serial's lock before the row is left to load again: a holder keeps it for one check and one insert. */
const SERIAL_LOCK_TRIES = 5

/**
 * After-insert rule on ASN import rows: create the in-transit Asset (ASN = scan-to-confirm receiving).
 *
 * A first scan of the serial without an ASN (entry/warehouse) could create its Asset between this row's check and its
 * insert, and both would stand. So the check and the insert are made under the serial's lock, which that scan takes
 * too (domain/asn `receiveSerialLockName`), checking again there. A row that finds the lock held through every try, or
 * whose lock cannot be taken (platform/locks throws), is marked error with why, to load again; loaded again once the
 * scan has created the Asset, it is refused as a serial that already exists.
 */
export function processAsnRow(current: GlideRecord): void {
    const serial = normalizeSerial(str(current, 'serial'))
    // Most refused rows (a missing field, a serial known long since) are refused here, without the lock.
    const check = checkAsnRow(current, serial)
    if (!check.ok) return finish(current, 'error', check.reason)

    const raw = { manufacturer: str(current, 'manufacturer'), model: str(current, 'pid') }
    const resolution = resolveModel(raw, loadNormalizationData())
    const modelId = resolution.modelId
    if (!modelId) {
        recordNormalizationException(raw, 'reason' in resolution ? resolution.reason : '', {
            table: 'x_daas_ham_asn_import',
            id: current.getUniqueValue(),
        })
        return finish(current, 'error', `PID ${raw.model} does not map to a model; see normalization exceptions`)
    }

    // Set inside the serial's lock: the insert's own errors escape, and only a lock that could not be taken is marked.
    let started = false as boolean
    let outcome = loadAgain(serial, 'a scan or another row is receiving it')
    try {
        withLockTries(receiveSerialLockName(serial), SERIAL_LOCK_TRIES, (lock) => {
            started = true
            outcome = insertHolding(lock, current, serial, modelId)
        })
    } catch (error) {
        if (started) throw error
        outcome = loadAgain(serial, error instanceof Error ? error.message : String(error))
    }
    finish(current, outcome.state, outcome.comment)
}

/** A row the serial's lock kept from importing, marked error with why: loading it again imports or refuses it. */
function loadAgain(serial: string, why: string): RowOutcome {
    return { state: 'error', comment: `serial ${serial} not imported: ${why}; load this row again` }
}

/** The row checked (domain/asn `validateAsnRows`): its mandatory fields, and that no Asset has its serial yet. */
function checkAsnRow(row: GlideRecord, serial: string): AsnRowCheck {
    const fields = { serial, pid: str(row, 'pid'), poNumber: str(row, 'po_number') }
    return validateAsnRows([fields], serialExists(serial) ? new Set([serial]) : new Set())[0]
}

/**
 * Check the row again and insert its Asset, holding the serial's `lock`. A holder that outlasted the lock (ADR 0013)
 * may overlap the scan or row that took it over: it inserts only while it holds it, and one that lost it during the
 * insert is logged.
 */
function insertHolding(lock: HeldLock, row: GlideRecord, serial: string, modelId: string): RowOutcome {
    const check = checkAsnRow(row, serial)
    if (!check.ok) return { state: 'error', comment: check.reason }
    if (!lock.held()) return loadAgain(serial, 'its lock was lost while checking it')
    const asset = newAsset(modelId, 'in_transit')
    asset.setValue('serial_number', serial)
    asset.setValue('po_number', str(row, 'po_number'))
    asset.setValue('company', stringProperty(PROPERTY.providerCompany))
    asset.setValue('x_daas_ham_legal_owner', 'provider')
    asset.setValue('x_daas_ham_customer_tag', str(row, 'customer_tag'))
    asset.setValue('x_daas_ham_mac_address', str(row, 'mac_address'))
    asset.setValue('x_daas_ham_claim_code', str(row, 'claim_code'))
    const stagingSource = str(row, 'staging_source') === 'distributor' ? 'distributor' : 'in_house'
    asset.setValue('x_daas_ham_staging_source', stagingSource)
    if (!asset.insert()) return { state: 'error', comment: `Asset insert failed: ${refusal(asset)}` }
    if (!lock.held()) gs.warn(`[x_daas_ham] Asset ${serial} created after its lock was lost: check it exists once`)
    return { state: 'inserted', comment: `Asset ${serial} in transit` }
}

/**
 * Whether an Asset has the serial, read past the importer's before-query rules (ADR 0005): an inventory tech sees only
 * their stockrooms' Assets, and an Asset in transit or on order is in none yet. Only read, never saved.
 */
function serialExists(serial: string): boolean {
    const asset = new GlideRecord('alm_hardware')
    asset.setWorkflow(false)
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
    const saved = exists ? lifecycle.update() : lifecycle.insert()
    if (!saved) return finish(current, 'error', `Lifecycle for ${parsed.pid} not saved: ${refusal(lifecycle)}`)
    finish(current, exists ? 'updated' : 'inserted', `Lifecycle for ${parsed.pid}`)
}
