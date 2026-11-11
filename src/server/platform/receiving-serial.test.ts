import { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stageOf } from '../domain/lifecycle.ts'
import { importAsnRow, receive } from './receiving.ts'
import { platform, type Row } from '../test-support/fake-glide.ts'

/*
 * The Asset of a serial the app has none for, created by a first scan with its PID or by an ASN row, against the
 * in-memory stand-in for the platform, job locks included.
 */

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const ASSETS = 'alm_hardware'
const ASN = 'x_daas_ham_asn_import'
const LOCKS = 'x_daas_ham_job_lock'

const assets = (): Row[] => platform.tables[ASSETS] ?? []
const assetOf = (serial: string): Row | undefined => assets().find((asset) => asset.serial_number === serial)
const stageOfAsset = (serial: string) => {
    const asset = assetOf(serial)
    return asset && stageOf({ installStatus: asset.install_status, substatus: asset.substatus })
}

function asnRow(values: Row): GlideRecord {
    platform.tables[ASN] = [{ sys_id: 'row1', manufacturer: '', pid: 'C9300-24T', po_number: 'PO100', ...values }]
    const row = new GlideRecord(ASN)
    row.get('row1')
    return row
}

beforeEach(() => {
    platform.reset()
    platform.uniqueKeys = { [LOCKS]: 'name' }
    platform.references = { [`${ASSETS}.model`]: 'cmdb_model', [`${ASSETS}.stockroom`]: 'alm_stockroom' }
    platform.tables.cmdb_model = [{ sys_id: 'model1', x_daas_ham_oem_pid: 'C9300-24T', cmdb_model_category: 'cat1' }]
    platform.tables.alm_stockroom = [{ sys_id: 'depot1', name: 'Central depot', x_daas_ham_stockroom_type: 'central_depot' }]
    platform.tables[ASSETS] = [{ sys_id: 'known', serial_number: 'FOC111', x_daas_ham_fleet: 'true', install_status: '6', substatus: 'available' }]
})

describe('a first scan of an unknown serial with its PID', () => {
    it('creates its fleet Asset once, of the Model the PID names, and receives it', () => {
        expect(receive({ code: ' foc222 ', pid: 'C9300-24T' }, 'depot1')).toHaveProperty('asset')
        expect(assetOf('FOC222')).toMatchObject({ model: 'model1', x_daas_ham_fleet: 'true', stockroom: 'depot1' })
        expect(stageOfAsset('FOC222')).toBe('available')

        expect(receive({ code: 'FOC222', pid: 'C9300-24T' }, 'depot1')).toMatchObject({ reason: 'conflict' })
        expect(assets()).toHaveLength(2)
    })

    it('creates nothing while another receipt holds the serial, and is told to scan again', () => {
        platform.tables[LOCKS] = [{ sys_id: 'lock1', name: 'receive_serial_FOC222', sys_created_on: '2025-11-09 12:00:00' }]
        expect(receive({ code: 'FOC222', pid: 'C9300-24T' }, 'depot1')).toEqual({ reason: 'busy', why: 'Another scan is receiving this unit: scan again' })
        expect(assets()).toHaveLength(1)
    })
})

describe('an ASN row', () => {
    it('creates its fleet Asset in transit, with what the row says of it', () => {
        const row = asnRow({ serial: 'foc333', customer_tag: 'CT-1', mac_address: 'aa:bb', claim_code: 'CL1', staging_source: 'distributor' })
        expect(importAsnRow(row)).toEqual({ state: 'inserted', comment: 'Asset FOC333 in transit' })
        expect(stageOfAsset('FOC333')).toBe('in_transit')
        expect(assetOf('FOC333')).toMatchObject({
            model: 'model1',
            x_daas_ham_fleet: 'true',
            po_number: 'PO100',
            x_daas_ham_customer_tag: 'CT-1',
            x_daas_ham_mac_address: 'aa:bb',
            x_daas_ham_claim_code: 'CL1',
            x_daas_ham_staging_source: 'distributor',
        })
    })

    it('is refused for a serial an Asset has already, creating none', () => {
        expect(importAsnRow(asnRow({ serial: 'FOC111' }))).toEqual({ state: 'error', comment: 'serial FOC111 already exists' })
        expect(assets()).toHaveLength(1)
    })

    it('creates nothing while a scan holds the serial, and is marked to load again', () => {
        platform.tables[LOCKS] = [{ sys_id: 'lock1', name: 'receive_serial_FOC333', sys_created_on: '2025-11-09 12:00:00' }]
        expect(importAsnRow(asnRow({ serial: 'FOC333' }))).toEqual({
            state: 'error',
            comment: 'serial FOC333 not imported: a scan or another row is receiving it; load this row again',
        })
        expect(assets()).toHaveLength(1)
    })
})
