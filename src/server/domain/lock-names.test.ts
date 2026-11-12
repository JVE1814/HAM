import { describe, expect, it } from 'vitest'
import { LOCK, LOCK_NAME_LENGTH } from './lock-names'

const sysId = (c: string) => c.repeat(32)
const fee = { type: 'late_return' as const, assetId: sysId('a'), returnOrderId: sysId('r') }

type Locks = typeof LOCK
/** The locks named by more than record ids, which the type system makes this test name arguments for. */
type AllIds<P extends unknown[]> = { [I in keyof P]: string extends P[I] ? true : false }[number] extends true ? true : false
type TakesMoreThanIds = { [K in keyof Locks]: AllIds<Parameters<Locks[K]>> extends true ? never : K }[keyof Locks]
const ARGUMENTS: { [K in TakesMoreThanIds]: (id: string) => Parameters<Locks[K]> } = {
    fee: (id) => [{ ...fee, assetId: id }],
    reconException: (id) => ['rack_overlap', id],
}
const lockOf = (key: string) => LOCK[key as keyof Locks] as (...args: unknown[]) => string

/** One name of every lock, in the registry's order, each naming the record `id` wherever it names one. */
function oneOfEach(id: string): string[] {
    return Object.keys(LOCK).map((key) => {
        const lock = lockOf(key)
        const args = ARGUMENTS[key as TakesMoreThanIds]
        return lock(...(args ? args(id) : Array<string>(lock.length).fill(id)))
    })
}

const recordless = Object.keys(LOCK).filter((key) => lockOf(key).length === 0)

describe('LOCK', () => {
    it('names each lock as the locks held across an upgrade are named', () => {
        const a = sysId('a')
        const b = sysId('b')
        expect(LOCK.refreshOrders()).toBe('refresh_orders')
        expect(LOCK.agreementUsage(a)).toBe(`agreement_usage_${a}`)
        expect(LOCK.oemClaimRun()).toBe('oem_claim_run')
        expect(LOCK.oemCoverageRun()).toBe('oem_coverage_run')
        expect(LOCK.seenAsset(a)).toBe(`seen_asset_${a}`)
        expect(LOCK.receiveSerial('FOC123')).toBe('receive_serial_FOC123')
        expect(LOCK.receiveAsset(a)).toBe(`receive_asset_${a}`)
        expect(LOCK.sourceOrder(a)).toBe(`source_order_${a}`)
        expect(LOCK.shipOrder(a)).toBe(`ship_order_${a}`)
        expect(LOCK.trackShipment(a)).toBe(`track_shipment_${a}`)
        expect(LOCK.returnLabel(a)).toBe(`return_label_${a}`)
        expect(LOCK.orderLine(a)).toBe(`order_line_${a}`)
        expect(LOCK.providerTagSequence()).toBe('provider_tag_sequence')
        expect(LOCK.sparePool(a, b)).toBe(`spare_pool_${a}_${b}`)
        expect(LOCK.reserveAsset(a)).toBe(`reserve_asset_${a}`)
        expect(LOCK.returnRequest(a)).toBe(`return_request_${a}`)
        expect(LOCK.returnAsset(a)).toBe(`return_asset_${a}`)
        expect(LOCK.fee(fee)).toBe(`fee_late_return_${sysId('a')}_${sysId('r')}`)
        expect(LOCK.audit(a)).toBe(`audit_${a}`)
        expect(LOCK.reconException('audit_missing', a)).toBe(`recon_exception_audit_missing_${a}`)
        expect(LOCK.reconException('rack_overlap', '')).toBe('recon_exception_rack_overlap_')
        expect(LOCK.subscriptionLine(a)).toBe(`subscription_line_${a}`)
        expect(LOCK.serviceInterval(a)).toBe(`service_interval_${a}`)
        expect(LOCK.billingPeriod(a)).toBe(`billing_period_${a}`)
        expect(LOCK.job(`margin_${a}`)).toBe(`margin_${a}`)
    })

    it('gives every lock, and every record of one, a name of its own', () => {
        const names = [...oneOfEach(sysId('a')), ...oneOfEach(sysId('b'))]
        expect(new Set(names).size).toBe(names.length - recordless.length)
    })

    it('locks each fee identity on its own', () => {
        const names = [fee, { ...fee, type: 'lost' as const }, { ...fee, assetId: sysId('b') }, { ...fee, returnOrderId: sysId('s') }].map(
            LOCK.fee,
        )
        expect(new Set(names).size).toBe(names.length)
    })

    it('names one lock for a serial however it is typed, so a scan and an ASN row take the same one', () => {
        expect(LOCK.receiveSerial(' foc123 ')).toBe('receive_serial_FOC123')
        expect(LOCK.receiveSerial('FOC123')).toBe(LOCK.receiveSerial('foc123'))
    })

    it('fits every name of sys_ids in the Job lock name', () => {
        for (const name of oneOfEach(sysId('a'))) expect(name.length).toBeLessThanOrEqual(LOCK_NAME_LENGTH)
    })

    it('cuts a longer name to the Job lock name, whichever lock it is', () => {
        const long = 'X'.repeat(200)
        expect(LOCK.receiveSerial(long)).toBe(`receive_serial_${long}`.slice(0, LOCK_NAME_LENGTH))
        expect(LOCK.job(long)).toHaveLength(LOCK_NAME_LENGTH)
        expect(LOCK.sparePool(long, long)).toHaveLength(LOCK_NAME_LENGTH)
    })
})
