import { normalizeSerial } from './asn.ts'
import type { ExceptionType } from './vocabulary.ts'
import type { FeeIdentity } from './returns.ts'

/** A job lock's name is the unique key of its row (x_daas_ham_job_lock.name): a longer one shares its lock with those it starts like. */
export const LOCK_NAME_LENGTH = 100

function named(name: string): string {
    return name.slice(0, LOCK_NAME_LENGTH)
}

/**
 * Every job lock the app takes, declared in the one order they may be taken in (ADR 0013, which also says who takes
 * what under what): locks are not re-entrant and a take never waits, so a holder only takes locks declared after those
 * it holds.
 */
export const LOCK = {
    /** Held by the daily refresh run from its read of the Assets due to its last Order. */
    refreshOrders: () => named('refresh_orders'),
    /** An Asset's sightings (the device-events REST handler, the in-service detection job) take turns under it. */
    seenAsset: (assetId: string) => named(`seen_asset_${assetId}`),
    /**
     * The Asset of a serial not yet known is created under it, by a first scan without an ASN and by an ASN row alike,
     * so the two create one Asset. One lock for a serial however it is typed.
     */
    receiveSerial: (serial: string) => named(`receive_serial_${normalizeSerial(serial)}`),
    /** A unit's receipt, and the declaration that it is missing, take turns under it. */
    receiveAsset: (assetId: string) => named(`receive_asset_${assetId}`),
    /**
     * An Order's sourcing passes take turns under it, so two never count the same shortfall, and Cancel order holds it,
     * so a pass never reserves or buys for lines being cancelled.
     */
    sourceOrder: (orderId: string) => named(`source_order_${orderId}`),
    /** A Ship of the Order, Cancel order and a void of one of its outbound labels take turns under it. */
    shipOrder: (orderId: string) => named(`ship_order_${orderId}`),
    /** A Shipment's tracking updates and Mark label voided are saved under it: nothing is taken under it. */
    trackShipment: (shipmentId: string) => named(`track_shipment_${shipmentId}`),
    /** A Return order's open-label check, label purchase and Shipment are made under it. */
    returnLabel: (returnOrderId: string) => named(`return_label_${returnOrderId}`),
    /**
     * An Order line's need is read and changed under it: sourcing reads its units and on-order count there and saves
     * what it bought, and a receipt takes its unit off order and allocates it. So neither change is lost, and sourcing's
     * count never sees half a receipt.
     */
    orderLine: (lineId: string) => named(`order_line_${lineId}`),
    /** The Provider tag counter is read and advanced under it. */
    providerTagSequence: () => named('provider_tag_sequence'),
    /** The daily top-up counts, fills and buys for one Customer's Spare pool of one Model under it. */
    sparePool: (customerId: string, modelId: string) => named(`spare_pool_${customerId}_${modelId}`),
    /** An Asset's stock lock: every claim of it, and every change a claim could race, is made under it. */
    reserveAsset: (assetId: string) => named(`reserve_asset_${assetId}`),
    /** A fee is checked and charged under it: one per fee identity. */
    fee: (fee: FeeIdentity) => named(`fee_${fee.type}_${fee.assetId}_${fee.returnOrderId}`),
    /** An exception of one type on one subject (an Asset, or a CI such as a rack) is checked and opened under it. */
    reconException: (type: ExceptionType, subjectId: string) => named(`recon_exception_${type}_${subjectId}`),
    /** A pending Subscription line is started under it: nothing is taken under it. */
    subscriptionLine: (lineId: string) => named(`subscription_line_${lineId}`),
    /** The open and the close of an Asset's Service interval take turns under it. */
    serviceInterval: (assetId: string) => named(`service_interval_${assetId}`),
    /** A superseding job's lock (the margin recompute's), named as its job cursor is. */
    job: (job: string) => named(job),
} as const
