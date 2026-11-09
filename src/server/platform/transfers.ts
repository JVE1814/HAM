import { GlideRecord, gs } from '@servicenow/glide'
import { transferFellThrough, type TransferContext } from '../domain/lifecycle.ts'
import { createMarks } from '../domain/marks.ts'
import type { TransferResult } from '../domain/sourcing.ts'
import { moveAsset } from './assets.ts'
import { beyondVisibility } from './beyond-visibility.ts'
import { PROPERTY, stagingStockroom, stringProperty } from './properties.ts'
import { bool, deleteWhere, refusal, str } from './records.ts'

/**
 * Transfer orders (alm_transfer_order) moving stock between the Provider's stockrooms, one line per Asset. While a
 * line is open, Inventory keeps its Asset In transfer (domain/lifecycle; external-contracts N38); once it lets the
 * Asset go, the Asset takes back the stage it left (entry/assets `onTransferReleased`).
 */

/**
 * Request a transfer order moving reserved stock to the staging centre. Inventory takes a unit onto a line only from
 * In stock / Available (its rule *Validate TOL and check availibility* refuses any other substatus the app uses), so
 * each unit is handed over there first, still on its Order line and so claimed by nobody else; inserting its line then
 * has Inventory put it In transfer. A transfer order is only good with all its lines: when Inventory does not create
 * the header or one of the lines, or a unit cannot be handed over, what was created is removed (or, if it cannot be,
 * named in the reason for cancelling), a warning is logged and the result says why. Removing a line lets its Asset go,
 * reserved for its Order line again where it was (domain/lifecycle `stageAfterTransfer`); the units are marked as
 * withdrawn meanwhile, so that is not taken for a transfer fallen through (`fellShortOfStagingCentre`), and the caller
 * puts them back itself: read them again before changing them.
 */
export function requestTransfer(input: {
    fromStockroomId: string
    toStockroomId: string
    modelId: string
    assets: readonly GlideRecord[]
}): TransferResult {
    const transfer = new GlideRecord('alm_transfer_order')
    transfer.initialize()
    transfer.setValue('from_stockroom', input.fromStockroomId)
    transfer.setValue('to_stockroom', input.toStockroomId)
    const transferId = transfer.insert()
    if (!transferId) return noTransfer(input.fromStockroomId, 'Inventory did not create it')
    for (const asset of input.assets) {
        const refused = handOver(asset) ?? addLine(transferId, input.modelId, asset)
        if (refused === null) continue
        // The header too: its delete cascades to any line a rule kept, letting that unit go then.
        const removed = withdrawing(input.assets, () => {
            deleteWhere('alm_transfer_order_line', `transfer_order=${transferId}`)
            return transfer.deleteRecord()
        })
        const number = str(transfer, 'number')
        return noTransfer(input.fromStockroomId, removed ? refused : `${refused}; cancel ${number}`)
    }
    return { ok: true, transferId }
}

/** Save the Asset In stock / Available for Inventory to take onto a line; why not, or null once saved. */
function handOver(asset: GlideRecord): string | null {
    const serial = str(asset, 'serial_number')
    const verdict = moveAsset(asset, 'available')
    if (!verdict.allowed) return `${serial} could not be handed over: ${verdict.reason}`
    return asset.update() ? null : `${serial} could not be handed over: ${refusal(asset)}`
}

/** Insert the Asset's line on the transfer order; why not, or null once inserted. */
function addLine(transferId: string, modelId: string, asset: GlideRecord): string | null {
    const line = new GlideRecord('alm_transfer_order_line')
    line.initialize()
    line.setValue('transfer_order', transferId)
    line.setValue('model', modelId)
    line.setValue('asset', asset.getUniqueValue())
    line.setValue('quantity_requested', 1)
    return line.insert() ? null : `Inventory did not create the line of ${str(asset, 'serial_number')}: ${refusal(line)}`
}

function noTransfer(fromStockroomId: string, reason: string): TransferResult {
    gs.warn(`[x_daas_ham] No transfer order from stockroom ${fromStockroomId} (${reason})`)
    return { ok: false, reason }
}

/**
 * The Assets (sys_ids) whose transfer order lines `requestTransfer` is removing. Inventory lets each go in the same
 * transaction, and its rules read the mark there: a module's state is shared by every script of one transaction and
 * gone in the next (external-contracts N37, as for platform/beyond-visibility).
 */
const withdrawn = createMarks<string>()

/** Run `remove` with every one of `assets` marked as withdrawn by sourcing; what it returns. */
function withdrawing<R>(assets: readonly GlideRecord[], remove: () => R): R {
    const [first, ...rest] = assets
    return first === undefined ? remove() : withdrawn.during(String(first.getUniqueValue()), () => withdrawing(rest, remove))
}

/**
 * Whether Inventory has the Asset on an open transfer order line (domain/lifecycle `TransitionFacts`): its *Active
 * transfer order* flag (alm_asset.active_to, read-only), which Inventory sets with In transfer when it takes the unit
 * onto a line and clears with In stock / Available when the line is received, cancelled or deleted, in the same save.
 * The flag, not a query of the lines: on a line's insert the Asset is saved before the line is written.
 */
export function onTransferOrderLine(asset: GlideRecord): boolean {
    return bool(asset, 'active_to')
}

/**
 * What the Asset Inventory let go carries, and where it was left (domain/lifecycle `TransferContext`): what tells the
 * stage it left (`stageAfterTransfer`) and whether its transfer fell through (`transferFellThrough`).
 */
export function transferContext(asset: GlideRecord): TransferContext {
    const company = str(asset, 'company')
    const staging = stagingStockroom()
    return {
        onOrderLine: !!str(asset, 'x_daas_ham_order_line'),
        stagingTaskOpen: openStagingTask(asset.getUniqueValue()),
        heldForCustomer: !!company && company !== stringProperty(PROPERTY.providerCompany),
        atStagingCentre: !!staging && str(asset, 'stockroom') === staging,
        withdrawnBySourcing: withdrawn.has(String(asset.getUniqueValue())),
    }
}

/**
 * Whether Inventory let the Asset go from the transfer sourcing raised for it short of the staging centre, its line
 * cancelled or deleted (domain/lifecycle `transferFellThrough`): read once the save that let it go is made, from the
 * Asset as saved.
 */
export function fellShortOfStagingCentre(asset: GlideRecord): boolean {
    return !onTransferOrderLine(asset) && transferFellThrough(transferContext(asset))
}

/**
 * Whether a Staging task is open for the Asset, read past the visibility rules (ADR 0005): an inventory tech receiving
 * the line at the staging centre does not see a task whose Asset is still stored in the stockroom it left.
 */
function openStagingTask(assetId: string): boolean {
    const task = new GlideRecord('x_daas_ham_staging_task')
    task.addQuery('asset', assetId)
    task.addQuery('active', true)
    task.setLimit(1)
    beyondVisibility(task, () => task.query())
    return task.hasNext()
}
