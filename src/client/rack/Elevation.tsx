import { useMemo, type CSSProperties } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress, ProgressLabel } from '@/components/ui/progress'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { devicePlacement, rackElevation, RACK_FACES, type PowerBudget } from '../../server/domain/rack'
import type { AssetStage, RackDevice, RackElevation } from '../../server/domain/rest-contracts'
import { supportRisk, type SupportRisk } from '../../server/domain/support-risk'
import { stageText } from '../stage'

export type ColourBy = 'stage' | 'customer' | 'risk'

export const COLOUR_BY: Record<ColourBy, string> = { stage: 'Lifecycle stage', customer: 'Customer', risk: 'EoX / coverage risk' }

/*
 * The theme's chart tokens are five greys, which cannot tell a healthy device from one at risk, so the fills that
 * carry a meaning are Tailwind's palette; text on every fill is white in both themes.
 */
const STAGE_FILLS: Partial<Record<AssetStage, string>> = {
    in_service: 'bg-emerald-600',
    pending_in_service: 'bg-amber-600',
    temporary_deployment: 'bg-blue-600',
}

const RISK_FILLS: Record<SupportRisk, string> = { high: 'bg-destructive', medium: 'bg-amber-600', low: 'bg-emerald-600' }

const NEUTRAL_FILL = 'bg-zinc-500'

const UNIT_HEIGHT_PX = 22

export const assetHref = (device: RackDevice) => `/alm_hardware.do?sys_id=${device.id}`

function hashColour(text: string): string {
    let hash = 0
    for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) | 0
    return `hsl(${Math.abs(hash) % 360} 55% 45%)`
}

function fill(device: RackDevice, colourBy: ColourBy, today: string): { className?: string; style?: CSSProperties } {
    if (colourBy === 'customer') return { style: { background: hashColour(device.customer) } }
    if (colourBy === 'risk') return { className: RISK_FILLS[supportRisk(device, today)] }
    return { className: STAGE_FILLS[device.stage] ?? NEUTRAL_FILL }
}

/** Every face of the rack, top unit first; a device spans its height and, for provider staff, opens its Asset form. */
export function RackFaces({ detail, colourBy, linkAssets }: { detail: RackElevation; colourBy: ColourBy; linkAssets: boolean }) {
    const today = new Date().toISOString().slice(0, 10)
    // Keyed by sys_id, as the elevation's rows are: two devices can share a tag, or have neither a tag nor a serial.
    const byId = useMemo(() => new Map(detail.devices.map((d) => [d.id, d])), [detail])
    const placements = useMemo(() => detail.devices.map(devicePlacement), [detail])

    return (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(20rem,100%),1fr))] gap-6">
            {RACK_FACES.map((face) => (
                <Card key={face} size="sm">
                    <CardHeader>
                        <CardTitle>
                            {detail.rack.name} · {face}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <ol className="overflow-hidden rounded-md border-2 bg-card">
                            {rackElevation(detail.rack.units, placements, face).map((row) => {
                                const device = row.assetId ? byId.get(row.assetId) : undefined
                                const colour = device ? fill(device, colourBy, today) : {}
                                return (
                                    <li
                                        key={row.unit}
                                        className={cn(
                                            'flex items-center gap-2 border-b px-2 text-xs last:border-b-0',
                                            device ? 'font-semibold text-white' : 'text-muted-foreground',
                                            colour.className,
                                        )}
                                        style={{ height: row.span * UNIT_HEIGHT_PX, ...colour.style }}
                                    >
                                        <span className="w-[2.5em] shrink-0 font-mono font-normal">{row.unit}</span>
                                        {device && (
                                            <Tooltip>
                                                <TooltipTrigger
                                                    className="truncate"
                                                    render={
                                                        linkAssets ? (
                                                            <a href={assetHref(device)} target="_blank" rel="noreferrer" className="hover:underline" />
                                                        ) : (
                                                            <span />
                                                        )
                                                    }
                                                >
                                                    {row.label} · {device.model}
                                                </TooltipTrigger>
                                                <TooltipContent>
                                                    {device.serial} · {stageText(device.stage)}
                                                </TooltipContent>
                                            </Tooltip>
                                        )}
                                    </li>
                                )
                            })}
                        </ol>
                    </CardContent>
                </Card>
            ))}
        </div>
    )
}

export function PowerBar({ power }: { power: PowerBudget }) {
    if (power.utilisation === null) return <p className="text-sm">Typical power {power.usedW} W (no rack capacity recorded)</p>
    const over = power.utilisation > 100
    return (
        <Progress value={Math.min(power.utilisation, 100)} className={cn(over && 'text-destructive [&_[data-slot=progress-indicator]]:bg-destructive')}>
            <ProgressLabel className={cn(over && 'text-destructive')}>
                Power {power.usedW} W of {power.capacityW} W ({power.utilisation}%)
            </ProgressLabel>
        </Progress>
    )
}
