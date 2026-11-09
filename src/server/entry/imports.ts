// Entry points: parameter names must be the platform globals (current, previous, event, request,
// response) because the SDK's generated wrapper passes them by name.
import { GlideRecord } from '@servicenow/glide'
import { normalizeSerial, validateAsnRows, type AsnRowCheck } from '../domain/asn.ts'
import { messageOf } from '../domain/errors.ts'
import type { HeldLock } from '../domain/job-lock.ts'
import { LOCK } from '../domain/lock-names.ts'
import { parseLifecycleRow } from '../domain/model-lifecycle.ts'
import { newAsset } from '../platform/assets.ts'
import { beyondVisibility } from '../platform/beyond-visibility.ts'
import { attemptLock } from '../platform/locks.ts'
import { writeModelLifecycle } from '../platform/model-lifecycle.ts'
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

/**
 * After-insert rule on ASN import rows: create the in-transit Asset (ASN = scan-to-confirm receiving).
 *
 * A first scan of the serial without an ASN (entry/warehouse) could create its Asset between this row's check and its
 * insert, and both would stand. So the check and the insert are made under the serial's lock, which that scan takes
 * too, checking again there. A row that finds the lock held through every try (a holder keeps it for one check and one
 * insert), or whose lock cannot be taken, is marked error with why, to load again; loaded again once the scan has
 * created the Asset, it is refused as a serial that already exists.
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

    const attempt = attemptLock(LOCK.receiveSerial(serial), (lock) => insertHolding(lock, current, serial, modelId))
    if (attempt.ran) return finish(current, attempt.value.state, attempt.value.comment)
    const unloaded = loadAgain(serial, attempt.held ? 'a scan or another row is receiving it' : messageOf(attempt.error))
    finish(current, unloaded.state, unloaded.comment)
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
 * insert is logged. Made by `newAsset`, the Asset is a fleet asset (ADR 0016) the Provider owns.
 */
function insertHolding(lock: HeldLock, row: GlideRecord, serial: string, modelId: string): RowOutcome {
    const check = checkAsnRow(row, serial)
    if (!check.ok) return { state: 'error', comment: check.reason }
    const asset = newAsset(modelId, 'in_transit')
    asset.setValue('serial_number', serial)
    asset.setValue('po_number', str(row, 'po_number'))
    asset.setValue('company', stringProperty(PROPERTY.providerCompany))
    asset.setValue('x_daas_ham_customer_tag', str(row, 'customer_tag'))
    asset.setValue('x_daas_ham_mac_address', str(row, 'mac_address'))
    asset.setValue('x_daas_ham_claim_code', str(row, 'claim_code'))
    const stagingSource = str(row, 'staging_source') === 'distributor' ? 'distributor' : 'in_house'
    asset.setValue('x_daas_ham_staging_source', stagingSource)
    const saved = lock.save(`Asset ${serial} created`, () => asset.insert(), { check: 'check it exists once' })
    if (saved === 'lock lost') return loadAgain(serial, 'its lock was lost while checking it')
    if (saved === 'refused') return { state: 'error', comment: `Asset insert failed: ${refusal(asset)}` }
    return { state: 'inserted', comment: `Asset ${serial} in transit` }
}

/**
 * Whether an Asset has the serial, read past the importer's before-query rules (ADR 0005): an inventory tech sees only
 * their stockrooms' Assets, and an Asset in transit or on order is in none yet. Any Asset counts, the Provider IT's
 * too (ADR 0016), so a serial never has two. Only read, never saved.
 */
function serialExists(serial: string): boolean {
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('serial_number', serial)
    asset.setLimit(1)
    beyondVisibility(asset, () => asset.query())
    return asset.hasNext()
}

/**
 * After-insert rule on lifecycle import rows: store the row's milestones on its Model (platform/model-lifecycle,
 * source CSV). A milestone the row leaves blank keeps what is stored. A row with a milestone the platform refuses is
 * marked error with why, to load again once the cause is fixed: the milestones saved meanwhile are then found as given.
 */
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

    const written = writeModelLifecycle(resolution.modelId, parsed.dates, { source: 'csv', reference: str(current, 'source_reference') })
    if (written.refused.length > 0) return finish(current, 'error', `Lifecycle for ${parsed.pid} not saved: ${written.refused.join('; ')}`)
    const known = written.updated + written.unchanged
    if (known + written.inserted === 0) return finish(current, 'ignored', `No milestone date for ${parsed.pid}`)
    finish(current, known > 0 ? 'updated' : 'inserted', `Lifecycle for ${parsed.pid}`)
}
