import React from 'react'
import { barsOf, encodeCode128 } from './code128'
import type { AssetSummary } from '../../server/domain/rest-contracts'

/**
 * A printable Provider-tag label (Code 128 + human-readable lines). The bars are one path, one closed shape per bar,
 * so a wide bar has no inner edge to show as a hairline seam once the SVG is stretched to the label's width.
 */
export default function Label({ asset }: { asset: AssetSummary }) {
    const modules = encodeCode128(asset.providerTag || asset.serial)
    const quiet = 10
    const bars = barsOf(modules)
        .map(({ x, width }) => `M${x + quiet} 0h${width}v40h-${width}z`)
        .join('')
    return (
        <div className="label">
            <svg viewBox={`0 0 ${modules.length + quiet * 2} 40`} preserveAspectRatio="none" role="img" aria-label={asset.providerTag}>
                <path d={bars} />
            </svg>
            <div className="label-tag">{asset.providerTag}</div>
            <div className="label-meta">
                {asset.pid || asset.model} · SN {asset.serial}
            </div>
        </div>
    )
}
