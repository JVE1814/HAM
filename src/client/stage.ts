import type { AssetStage } from '../server/domain/rest-contracts'

export function stageText(stage: AssetStage): string {
    return stage.replace(/_/g, ' ')
}
