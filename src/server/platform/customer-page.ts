import { GlideRecord, gs } from '@servicenow/glide'
import { customerEquipmentQuery } from '../domain/customer-page.ts'
import { awaitsSelfInstallConfirmation } from '../domain/install-confirmation.ts'
import type { Attestation, AttestationItem, CustomerAsset, CustomerOrder, CustomerReturn } from '../domain/rest-contracts.ts'
import { SCOPED_TABLES, visibilityFilter } from '../domain/visibility.ts'
import { isFleetAsset, readStage } from './assets.ts'
import { installState } from './delivery.ts'
import { findById, str, warnRefused } from './records.ts'
import type { SessionScope } from './session.ts'
import { returnLabels } from './shipping.ts'
import { OPEN_ORDERS_QUERY } from '../domain/fulfilment.ts'

/*
 * What the customer self-service page shows and takes (P2.9, D49). Every query runs as the signed-in customer contact,
 * so the before-query visibility rules (ADR 0005) limit it to their Customer (site contacts: their Sites). Asset
 * managers may open the page as a preview, which shows every Customer. A server read is not checked by the read ACLs,
 * so a query with `^NQ` clauses carries the reader's filter in each one itself (customerEquipmentQuery). Only fleet
 * assets (ADR 0016) are the Customer's equipment, so each read checks the Fleet flag: the rules keep a contact to their
 * Customer's hardware, fleet or not, and show staff previewing the page all of it.
 */

/** The name of the Customer the page is shown for ('' when the user belongs to none). */
export function customerName(customerId: string): string {
    return findById('core_company', customerId)?.getDisplayValue('name') ?? ''
}

/** The Customer's equipment: the fleet assets the signed-in user may see, by Site. */
export function customerEquipment(session: SessionScope): CustomerAsset[] {
    const assets: CustomerAsset[] = []
    const asset = new GlideRecord('alm_hardware')
    asset.addEncodedQuery(customerEquipmentQuery(visibilityFilter(session.scope, SCOPED_TABLES.alm_hardware, session)))
    asset.orderBy('x_daas_ham_site')
    asset.setLimit(5000)
    asset.query()
    while (asset.next()) {
        assets.push({
            id: asset.getUniqueValue(),
            serial: str(asset, 'serial_number'),
            customerTag: str(asset, 'x_daas_ham_customer_tag'),
            model: asset.getDisplayValue('model'),
            site: asset.getDisplayValue('x_daas_ham_site'),
            siteId: str(asset, 'x_daas_ham_site'),
            stage: readStage(asset) ?? 'unknown',
            refreshDue: str(asset, 'x_daas_ham_refresh_due'),
        })
    }
    return assets
}

/** The Orders still under way, newest first, each with whether its self-install can be confirmed now. */
export function ordersUnderWay(): CustomerOrder[] {
    const orders: CustomerOrder[] = []
    const order = new GlideRecord('x_daas_ham_order')
    order.addEncodedQuery(OPEN_ORDERS_QUERY)
    order.orderByDesc('sys_created_on')
    order.setLimit(200)
    order.query()
    while (order.next()) {
        orders.push({
            id: order.getUniqueValue(),
            number: str(order, 'number'),
            type: order.getDisplayValue('order_type'),
            site: order.getDisplayValue('site'),
            stageLabel: order.getDisplayValue('stage'),
            canConfirmInstall: awaitsSelfInstallConfirmation(installState(order)),
        })
    }
    return orders
}

/** The open Return orders, each with its prepaid return label still in use ('' without one). */
export function openReturns(): CustomerReturn[] {
    const open: Array<{ id: string; listed: Omit<CustomerReturn, 'labelUrl' | 'trackingNumber'> }> = []
    const ret = new GlideRecord('x_daas_ham_return_order')
    ret.addQuery('active', true)
    ret.setLimit(200)
    ret.query()
    while (ret.next()) {
        open.push({
            id: ret.getUniqueValue(),
            listed: {
                number: str(ret, 'number'),
                site: ret.getDisplayValue('site'),
                trigger: ret.getDisplayValue('trigger'),
                dueDate: str(ret, 'due_back'),
            },
        })
    }
    const labels = returnLabels(open.map(({ id }) => id))
    return open.map(({ id, listed }) => {
        const label = labels.get(id)
        return { ...listed, labelUrl: label?.labelUrl ?? '', trackingNumber: label?.trackingNumber ?? '' }
    })
}

/** The open attestations, each with the devices to attest and the answers given so far. */
export function openAttestations(): Attestation[] {
    const attestations: Attestation[] = []
    const attestation = new GlideRecord('x_daas_ham_attestation')
    attestation.addQuery('active', true)
    attestation.setLimit(50)
    attestation.query()
    while (attestation.next()) {
        const items: AttestationItem[] = []
        const item = new GlideRecord('x_daas_ham_attestation_item')
        item.addQuery('attestation', attestation.getUniqueValue())
        item.query()
        while (item.next()) {
            items.push({
                id: item.getUniqueValue(),
                serial: str(item, 'asset.serial_number'),
                model: item.getDisplayValue('asset.model'),
                response: str(item, 'response') as AttestationItem['response'],
            })
        }
        attestations.push({ id: attestation.getUniqueValue(), number: str(attestation, 'number'), site: attestation.getDisplayValue('site'), items })
    }
    return attestations
}

/** What came of a fault report: the CSM case opened for it, or that the device is `unknown` or the case `refused` (logged). */
export type FaultCase = { opened: true; number: string } | { opened: false; reason: 'unknown' | 'refused' }

/**
 * Report a faulty device as a CSM case in the signed-in user's name. Visibility rules apply (a contact's Customer and
 * Sites), and only a fleet asset is replaced (ADR 0016): any other device is unknown.
 */
export function openFaultCase(assetId: string, description: string): FaultCase {
    const asset = findById('alm_hardware', assetId)
    if (!asset || !isFleetAsset(asset)) return { opened: false, reason: 'unknown' }
    const kase = new GlideRecord('sn_customerservice_case')
    kase.initialize()
    kase.setValue('account', str(asset, 'company'))
    kase.setValue('contact', gs.getUserID())
    kase.setValue('short_description', `Faulty device ${str(asset, 'asset_tag') || str(asset, 'serial_number')} at ${asset.getDisplayValue('x_daas_ham_site')}`)
    kase.setValue('description', description)
    kase.setValue('x_daas_ham_failed_asset', asset.getUniqueValue())
    if (kase.insert()) return { opened: true, number: str(kase, 'number') }
    warnRefused(kase, `No fault case for ${str(asset, 'serial_number')}`)
    return { opened: false, reason: 'refused' }
}
