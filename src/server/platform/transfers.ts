import { GlideRecord, gs } from '@servicenow/glide'
import { stageAfterTransfer, transferFellThrough, type TransferContext } from '../domain/lifecycle.ts'
import { createMarks } from '../domain/marks.ts'
import { PROPERTY } from '../domain/properties.ts'
import type { TransferResult } from '../domain/sourcing.ts'
import { moveAsset, moveRefusal, readStage } from './assets.ts'
import { stringProperty } from './properties.ts'
import { bool, deleteWhere, refusal, str, type ForeignRecord } from './records.ts'
import { hasOpenStagingTask, stagingStockroom } from './staging-tasks.ts'

/**
 * Transfer orders (alm_transfer_order) moving stock between the Provider's stockrooms, one line per Asset. While a
 * line is open, Inventory keeps its Asset In transfer (domain/lifecycle; external-contracts N38); once it lets the
 * Asset go, the Asset takes back the stage it left (`takeBackStageAfterTransfer`).
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
    const refused = moveRefusal(asset, 'available')
    return refused ? `${str(asset, 'serial_number')} could not be handed over: ${refused}` : null
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
export function onTransferOrderLine(asset: ForeignRecord): boolean {
    return bool(asset, 'active_to')
}

/**
 * In the save by which Inventory lets `asset` go from its transfer order line (`before`: the Asset as stored), give it
 * back the stage it left; the save under way carries it. Inventory clears its flag and saves the Asset In stock:
 * Available (Reserved for a line requested for a user) in the transfer order's to-stockroom once received, Available
 * where it was when the line is cancelled or deleted (external-contracts N38, N39). The Asset takes back the stage it
 * left instead (domain/lifecycle `stageAfterTransfer`); the stockroom Inventory set is kept. Any other save is left as
 * it is: one putting the Asset onto a line, or one leaving it in transfer with the flag cleared (its line received
 * after its last task was closed skipped), for its stage to be set by hand. A stage the lifecycle refuses is logged.
 */
export function takeBackStageAfterTransfer(asset: ForeignRecord, before: ForeignRecord): void {
    const now = readStage(asset)
    const released = readStage(before) === 'in_transfer' && now !== 'in_transfer' && !onTransferOrderLine(asset)
    if (!released) return
    const stage = stageAfterTransfer(transferContext(asset))
    // From the stock Inventory made it: each stage it can take back is a move the matrix allows from there.
    const verdict = moveAsset(asset, stage)
    if (verdict.allowed) return
    gs.warn(`[x_daas_ham] ${str(asset, 'serial_number')} left its transfer as ${now}, not ${stage}: ${verdict.reason}`)
}

/**
 * What the Asset Inventory let go carries, and where it was left (domain/lifecycle `TransferContext`): what tells the
 * stage it left (`stageAfterTransfer`) and whether its transfer fell through (`transferFellThrough`).
 */
export function transferContext(asset: ForeignRecord): TransferContext {
    const company = str(asset, 'company')
    const staging = stagingStockroom()
    return {
        onOrderLine: !!str(asset, 'x_daas_ham_order_line'),
        stagingTaskOpen: hasOpenStagingTask(asset.getUniqueValue()),
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
export function fellShortOfStagingCentre(asset: ForeignRecord): boolean {
    return !onTransferOrderLine(asset) && transferFellThrough(transferContext(asset))
}
