import { describe, expect, it } from 'vitest'
import { LOCK, LOCK_NAME_LENGTH } from './lock-names'

const sysId = (c: string) => c.repeat(32)
const fee = { type: 'late_return' as const, assetId: sysId('a'), returnOrderId: sysId('r') }

/** One name of every lock, in the registry's order. */
function oneOfEach(id: string): string[] {
    return [
        LOCK.refreshOrders(),
        LOCK.seenAsset(id),
        LOCK.receiveSerial(id),
        LOCK.receiveAsset(id),
        LOCK.sourceOrder(id),
        LOCK.shipOrder(id),
        LOCK.trackShipment(id),
        LOCK.returnLabel(id),
        LOCK.orderLine(id),
        LOCK.providerTagSequence(),
        LOCK.sparePool(id, id),
        LOCK.reserveAsset(id),
        LOCK.fee({ ...fee, assetId: id }),
        LOCK.reconException('rack_overlap', id),
        LOCK.subscriptionLine(id),
        LOCK.serviceInterval(id),
        LOCK.job(`margin_${id}`),
    ]
}

describe('LOCK', () => {
    it('names each lock as the locks held across an upgrade are named', () => {
        const a = sysId('a')
        const b = sysId('b')
        expect(LOCK.refreshOrders()).toBe('refresh_orders')
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
        expect(LOCK.fee(fee)).toBe(`fee_late_return_${sysId('a')}_${sysId('r')}`)
        expect(LOCK.reconException('audit_missing', a)).toBe(`recon_exception_audit_missing_${a}`)
        expect(LOCK.reconException('rack_overlap', '')).toBe('recon_exception_rack_overlap_')
        expect(LOCK.subscriptionLine(a)).toBe(`subscription_line_${a}`)
        expect(LOCK.serviceInterval(a)).toBe(`service_interval_${a}`)
        expect(LOCK.job(`margin_${a}`)).toBe(`margin_${a}`)
    })

    it('gives every lock, and every record of one, a name of its own', () => {
        expect(oneOfEach(sysId('a'))).toHaveLength(Object.keys(LOCK).length)
        const names = [...oneOfEach(sysId('a')), ...oneOfEach(sysId('b'))]
        // The two locks that name no record are the same whatever the record.
        expect(new Set(names).size).toBe(names.length - 2)
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
