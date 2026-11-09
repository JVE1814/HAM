import React from 'react'
import { encodeCode128 } from './code128'
import type { AssetSummary } from '../../server/domain/rest-contracts'

/** A printable Provider-tag label (Code 128 + human-readable lines). */
export default function Label({ asset }: { asset: AssetSummary }) {
    const bars = encodeCode128(asset.providerTag || asset.serial)
    const quiet = 10
    return (
        <div className="label">
            <svg viewBox={`0 0 ${bars.length + quiet * 2} 40`} preserveAspectRatio="none" role="img" aria-label={asset.providerTag}>
                {[...bars].map((module, i) =>
                    module === '1' ? <rect key={i} x={i + quiet} y={0} width={1} height={40} /> : null,
                )}
            </svg>
            <div className="label-tag">{asset.providerTag}</div>
            <div className="label-meta">
                {asset.pid || asset.model} · SN {asset.serial}
            </div>
        </div>
    )
}
