import { GlideRecord } from '@servicenow/glide'
import { validateAsnRows, type AsnRowCheck } from '../domain/asn.ts'
import { isIsoDate } from '../domain/calendar.ts'
import type { CoverageAnswer } from '../domain/coverage.ts'
import { fleetCondition } from '../domain/fleet.ts'
import type { HeldLock } from '../domain/job-lock.ts'
import { LOCK } from '../domain/lock-names.ts'
import { parseLifecycleRow } from '../domain/model-lifecycle.ts'
import { SYNC_ORDER } from '../domain/oem/adapters.ts'
import type { CoverageFact } from '../domain/oem/types.ts'
import { normalizeSerial } from '../domain/serials.ts'
import { DEFAULT_STAGING_SOURCE } from '../domain/staging.ts'
import type { OemVendor, StagingSource } from '../domain/vocabulary.ts'
import { findAnyAsset, newAsset } from './assets.ts'
import { applyCoverage } from './coverage.ts'
import { attemptLock, whyNotRun } from './locks.ts'
import { writeModelLifecycle } from './model-lifecycle.ts'
import { loadNormalizationData, recordNormalizationException, resolveModel } from './normalization.ts'
import { choice, refusal, str, warnRefused } from './records.ts'

/** Import-set rows processed on insert (ASN, lifecycle CSV, coverage CSV): what each row comes to. */

type ImportState = 'inserted' | 'updated' | 'error' | 'ignored'

/** How a row ends: the import state and comment it is saved with. */
export interface RowOutcome {
    state: ImportState
    comment: string
}

/** Save how an import row ended on the row. */
export function finishImportRow(row: GlideRecord, outcome: RowOutcome): void {
    row.setValue('sys_import_state', outcome.state)
    row.setValue('sys_import_state_comment', outcome.comment)
    // The row was handled all the same; unsaved, it still shows as not imported.
    if (!row.update()) warnRefused(row, `Import row ${row.getUniqueValue()} of ${row.getTableName()}: outcome "${outcome.state}" not saved`)
}

function failed(comment: string): RowOutcome {
    return { state: 'error', comment }
}

/**
 * Import an ASN row: create its in-transit Asset (ASN = scan-to-confirm receiving).
 *
 * A first scan of the serial without an ASN (platform/receiving) could create its Asset between this row's check and its
 * insert, and both would stand. So the check and the insert are made under the serial's lock, which that scan takes
 * too, checking again there. A row that finds the lock held through every try (a holder keeps it for one check and one
 * insert), or whose lock cannot be taken, is marked error with why, to load again; loaded again once the scan has
 * created the Asset, it is refused as a serial that already exists.
 */
export function importAsnRow(row: GlideRecord): RowOutcome {
    const serial = normalizeSerial(str(row, 'serial'))
    // Most refused rows (a missing field, a serial known long since) are refused here, without the lock.
    const check = checkAsnRow(row, serial)
    if (!check.ok) return failed(check.reason)

    const raw = { manufacturer: str(row, 'manufacturer'), model: str(row, 'pid') }
    const resolution = resolveModel(raw, loadNormalizationData())
    const modelId = resolution.modelId
    if (!modelId) {
        recordNormalizationException(raw, 'reason' in resolution ? resolution.reason : '', {
            table: 'x_daas_ham_asn_import',
            id: row.getUniqueValue(),
        })
        return failed(`PID ${raw.model} does not map to a model; see normalization exceptions`)
    }

    const attempt = attemptLock(LOCK.receiveSerial(serial), (lock) => insertHolding(lock, row, serial, modelId))
    if (attempt.ran) return attempt.value
    return loadAgain(serial, whyNotRun(attempt, 'a scan or another row is receiving it'))
}

/** A row the serial's lock kept from importing, marked error with why: loading it again imports or refuses it. */
function loadAgain(serial: string, why: string): RowOutcome {
    return failed(`serial ${serial} not imported: ${why}; load this row again`)
}

/**
 * The row checked (domain/asn `validateAsnRows`): its mandatory fields, and that no Asset has its serial yet. Any
 * Asset counts, the Provider IT's too (ADR 0016), read past the importer's before-query rules (ADR 0005): an inventory
 * tech sees only their stockrooms' Assets, and an Asset in transit or on order is in none yet.
 */
function checkAsnRow(row: GlideRecord, serial: string): AsnRowCheck {
    const fields = { serial, pid: str(row, 'pid'), poNumber: str(row, 'po_number') }
    return validateAsnRows([fields], findAnyAsset(serial, 'serial') ? new Set([serial]) : new Set())[0]
}

/**
 * Check the row again and insert its Asset, holding the serial's `lock`. A holder that outlasted the lock (ADR 0013)
 * may overlap the scan or row that took it over: it inserts only while it holds it, and one that lost it during the
 * insert is logged. Made by `newAsset`, the Asset is a fleet asset (ADR 0016) the Provider owns.
 */
function insertHolding(lock: HeldLock, row: GlideRecord, serial: string, modelId: string): RowOutcome {
    const check = checkAsnRow(row, serial)
    if (!check.ok) return failed(check.reason)
    const asset = newAsset(modelId, 'in_transit')
    asset.setValue('serial_number', serial)
    asset.setValue('po_number', str(row, 'po_number'))
    asset.setValue('x_daas_ham_customer_tag', str(row, 'customer_tag'))
    asset.setValue('x_daas_ham_mac_address', str(row, 'mac_address'))
    asset.setValue('x_daas_ham_claim_code', str(row, 'claim_code'))
    const stagingSource: StagingSource = choice<StagingSource>(row, 'staging_source') === 'distributor' ? 'distributor' : DEFAULT_STAGING_SOURCE
    asset.setValue('x_daas_ham_staging_source', stagingSource)
    const saved = lock.save(`Asset ${serial} created`, () => asset.insert(), { check: 'check it exists once' })
    if (saved === 'lock lost') return loadAgain(serial, 'its lock was lost while checking it')
    if (saved === 'refused') return failed(`Asset insert failed: ${refusal(asset)}`)
    return { state: 'inserted', comment: `Asset ${serial} in transit` }
}

/**
 * Import a coverage row (vendors without an API): the coverage of a fleet asset's serial only. A row whose coverage
 * the platform refuses is marked error with why, to load again once the cause is fixed.
 */
export function importCoverageRow(row: GlideRecord): RowOutcome {
    const vendor = str(row, 'vendor') as OemVendor
    const serial = normalizeSerial(str(row, 'serial_number'))
    const start = str(row, 'start_date')
    const end = str(row, 'end_date')
    const cost = str(row, 'annual_cost').trim()
    if (!SYNC_ORDER.includes(vendor)) return failed(`vendor must be one of ${SYNC_ORDER.join(', ')}`)
    if (!serial) return failed('serial number is required')
    if ((start && !isIsoDate(start)) || (end && !isIsoDate(end))) return failed('dates must be real calendar dates (YYYY-MM-DD)')
    if (cost && !Number.isFinite(Number(cost))) return failed('annual cost must be a number')
    const asset = fleetAssetWithSerial(serial)
    if (!asset) return failed(`no fleet asset with serial ${serial}`)
    const assetId = asset.getUniqueValue()
    const fact: CoverageFact = {
        serial,
        covered: true,
        contractNumber: str(row, 'contract_number'),
        serviceLevel: str(row, 'service_level'),
        startDate: start || undefined,
        endDate: end || undefined,
    }
    const answer: CoverageAnswer = { assetId, fact, annualCost: cost ? Number(cost) : undefined }
    const refused = applyCoverage(vendor, 'csv', new Map([[assetId, serial]]), [answer], [])
    if (refused.length > 0) return failed(refused.join('; '))
    return { state: 'inserted', comment: `Coverage for ${serial}` }
}

/** The first fleet asset (ADR 0016) with this serial: one of the Provider IT's that carries it is not covered here. */
function fleetAssetWithSerial(serial: string): GlideRecord | null {
    const asset = new GlideRecord('alm_hardware')
    asset.addQuery('serial_number', serial)
    asset.addEncodedQuery(fleetCondition())
    asset.setLimit(1)
    asset.query()
    return asset.next() ? asset : null
}

/**
 * Import a lifecycle row: store its milestones on its Model (platform/model-lifecycle, source CSV). A milestone the
 * row leaves blank keeps what is stored. A row with a milestone the platform refuses is marked error with why, to load
 * again once the cause is fixed: the milestones saved meanwhile are then found as given.
 */
export function importLifecycleRow(row: GlideRecord): RowOutcome {
    const parsed = parseLifecycleRow({
        pid: str(row, 'pid'),
        endOfSale: str(row, 'end_of_sale'),
        endOfSupport: str(row, 'end_of_support'),
        endOfExtendedSupport: str(row, 'end_of_extended_support'),
        endOfLife: str(row, 'end_of_life'),
    })
    if (!parsed.ok) return failed(parsed.reason)

    const resolution = resolveModel({ manufacturer: str(row, 'manufacturer'), model: parsed.pid }, loadNormalizationData())
    if (!resolution.modelId) return failed(`PID ${parsed.pid} does not map to a model`)

    const written = writeModelLifecycle(resolution.modelId, parsed.dates, { source: 'csv', reference: str(row, 'source_reference') })
    if (written.refused.length > 0) return failed(`Lifecycle for ${parsed.pid} not saved: ${written.refused.join('; ')}`)
    const known = written.updated + written.unchanged
    if (known + written.inserted === 0) return { state: 'ignored', comment: `No milestone date for ${parsed.pid}` }
    return { state: known > 0 ? 'updated' : 'inserted', comment: `Lifecycle for ${parsed.pid}` }
}
