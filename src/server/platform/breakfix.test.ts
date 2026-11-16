import type { GlideRecord } from '@servicenow/glide'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fieldsOf } from '../domain/lifecycle.ts'
import { LOCK } from '../domain/lock-names.ts'
import { raiseReplacement, takeFailedAssetTerms } from './breakfix.ts'
import { findById, type ForeignRecord } from './records.ts'
import { platform, recordOf, type Row } from '../test-support/fake-glide.ts'

vi.mock('@servicenow/glide', async () => (await import('../test-support/fake-glide.ts')).glide)

const CASES = 'sn_customerservice_case'
const ORDERS = 'x_daas_ham_order'
const ASSETS = 'alm_hardware'
const LOCKS = 'x_daas_ham_job_lock'
const OTHER_CUSTOMERS = "The failed asset is not the case account's: set the account or the failed asset right first"

const rows = (table: string): Row[] => platform.tables[table] ?? []

function failedUnit(company: string): Row {
    const { installStatus, substatus } = fieldsOf('in_service')
    return {
        sys_id: 'asset1',
        serial_number: 'FOC111',
        x_daas_ham_fleet: 'true',
        company,
        x_daas_ham_site: 'site1',
        x_daas_ham_agreement: 'agr1',
        model: 'model1',
        install_status: installStatus,
        substatus: substatus ?? '',
    }
}

function storedCase(): GlideRecord {
    const found = findById(CASES, 'case1')
    if (!found) throw new Error('the case is not stored')
    return found
}

/** The case as the before rule is handed it: its failed asset just set, not saved yet. */
function savedCase(account: string): Row {
    const kase = recordOf<ForeignRecord>(CASES, { sys_id: 'case1', account, x_daas_ham_failed_asset: 'asset1' })
    takeFailedAssetTerms(kase)
    return { account: kase.getValue('account') ?? '', tier: kase.getValue('x_daas_ham_replacement_tier') ?? '' }
}

beforeEach(() => {
    platform.reset()
    platform.uniqueKeys = { [LOCKS]: 'name' }
    platform.references = { [`${ASSETS}.x_daas_ham_agreement`]: 'x_daas_ham_agreement' }
    platform.tables.x_daas_ham_agreement = [{ sys_id: 'agr1', replacement_tier: 'nbd' }]
    platform.tables[ASSETS] = [failedUnit('acme')]
    platform.tables[CASES] = [{ sys_id: 'case1', number: 'CS0001', account: 'acme', x_daas_ham_failed_asset: 'asset1' }]
})

describe('a case naming a failed asset', () => {
    it("takes the Asset's Customer and its Agreement's service level when it names no account", () => {
        expect(savedCase('')).toEqual({ account: 'acme', tier: 'nbd' })
    })

    it("takes the service level when its account is the Asset's Customer", () => {
        expect(savedCase('acme')).toEqual({ account: 'acme', tier: 'nbd' })
    })

    it("takes nothing from another Customer's Asset, and keeps its account", () => {
        expect(savedCase('other')).toEqual({ account: 'other', tier: '' })
    })
})

describe('Raise replacement', () => {
    it("raises no Order for a failed asset that is another Customer's than the case's account", () => {
        platform.tables[ASSETS] = [failedUnit('other')]

        expect(raiseReplacement(storedCase())).toEqual({ outcome: 'not_raised', why: OTHER_CUSTOMERS })

        expect(rows(ORDERS)).toEqual([])
        expect(rows(CASES)[0]?.x_daas_ham_replacement_order ?? '').toBe('')
    })

    it("goes on to raise the Order for the Asset's Customer, at its Site, when that is the case's account", () => {
        const tried: Row[] = []
        platform.refuses = (table, row, operation) => {
            if (table !== ORDERS || operation !== 'insert') return ''
            tried.push({ customer: row.customer ?? '', site: row.site ?? '' })
            return 'refused for this test'
        }

        expect(raiseReplacement(storedCase())).toEqual({ outcome: 'not_raised', why: 'Replacement order not raised: refused for this test' })

        expect(tried).toEqual([{ customer: 'acme', site: 'site1' }])
        expect(rows(LOCKS)).toEqual([])
    })

    it('raises nothing while another press holds the lock of the case, and says so', () => {
        const theirs = { sys_id: 'theirs', name: LOCK.replacementCase('case1'), sys_created_on: '2025-11-09 12:00:00' }
        platform.tables[LOCKS] = [theirs]

        expect(raiseReplacement(storedCase())).toEqual({ outcome: 'not_raised', why: 'A replacement is being raised for this case. Reload the case to see its Order' })

        expect(rows(ORDERS)).toEqual([])
        expect(rows(LOCKS)).toEqual([theirs])
    })

    it('keeps the Order another press linked after this form read the case, and raises no second one', () => {
        const readBefore = storedCase()
        platform.tables[ORDERS] = [{ sys_id: 'order1', number: 'ORD0001', stage: 'sourcing' }]
        platform.tables[CASES] = [{ sys_id: 'case1', number: 'CS0001', account: 'acme', x_daas_ham_failed_asset: 'asset1', x_daas_ham_replacement_order: 'order1' }]

        expect(raiseReplacement(readBefore)).toEqual({ outcome: 'already_raised', number: 'ORD0001', stageLabel: 'sourcing' })

        expect(rows(ORDERS)).toHaveLength(1)
        expect(rows(LOCKS)).toEqual([])
    })
})
