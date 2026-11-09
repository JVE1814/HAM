import type { AssetStage } from '../server/domain/rest-contracts'

/** A Lifecycle stage as the pages word it: `pending_in_service` reads "pending in service". */
export function stageText(stage: AssetStage): string {
    return stage.replace(/_/g, ' ')
}
