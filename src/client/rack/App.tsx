import React, { useEffect, useMemo, useState } from 'react'
import { rackElevation } from '../../server/domain/rack'
import { rackApi, type Rack, type RackDevice, type Site } from './api'

type ColourBy = 'stage' | 'customer' | 'risk'

const STAGE_COLOURS: Record<string, string> = {
    in_service: 'var(--ok)',
    pending_in_service: 'var(--warn)',
    pending_return: 'var(--muted)',
    temporary_deployment: 'var(--accent)',
}

function riskOf(device: RackDevice, today: string): 'high' | 'medium' | 'low' {
    if (['end_of_support', 'end_of_extended_support', 'end_of_life'].includes(device.lifecyclePhase)) return 'high'
    if (!device.coverageEnd || device.coverageEnd < today) return 'high'
    if (device.lifecyclePhase === 'end_of_sale' || (device.refreshDue && device.refreshDue < addDays(today, 180))) return 'medium'
    return 'low'
}

function addDays(date: string, days: number): string {
    return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

const RISK_COLOURS = { high: 'var(--error)', medium: 'var(--warn)', low: 'var(--ok)' }

function hashColour(text: string): string {
    let hash = 0
    for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) | 0
    return `hsl(${Math.abs(hash) % 360} 55% 45%)`
}

export default function App() {
    const [sites, setSites] = useState<Site[]>([])
    const [siteId, setSiteId] = useState('')
    const [racks, setRacks] = useState<Rack[]>([])
    const [rackId, setRackId] = useState('')
    const [detail, setDetail] = useState<{ rack: Rack; devices: RackDevice[] } | null>(null)
    const [colourBy, setColourBy] = useState<ColourBy>('stage')
    const [error, setError] = useState('')
    const today = new Date().toISOString().slice(0, 10)

    useEffect(() => {
        rackApi.sites().then(setSites).catch((e: Error) => setError(e.message))
    }, [])
    useEffect(() => {
        setRacks([])
        setRackId('')
        if (siteId) rackApi.racks(siteId).then(setRacks).catch((e: Error) => setError(e.message))
    }, [siteId])
    useEffect(() => {
        setDetail(null)
        if (rackId) rackApi.rack(rackId).then(setDetail).catch((e: Error) => setError(e.message))
    }, [rackId])

    const byId = useMemo(() => new Map((detail?.devices ?? []).map((d) => [d.tag || d.serial, d])), [detail])
    const colour = (device: RackDevice) =>
        colourBy === 'customer' ? hashColour(device.customer) : colourBy === 'risk' ? RISK_COLOURS[riskOf(device, today)] : STAGE_COLOURS[device.stage] ?? 'var(--muted)'

    return (
        <main className="racks">
            <h1>Rack elevations</h1>
            {error && <p className="error">{error}</p>}
            <section className="pickers">
                <label>
                    Site
                    <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                        <option value="">Choose a site</option>
                        {sites.map((s) => (
                            <option key={s.id} value={s.id}>
                                {s.name} ({s.customer})
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    Rack
                    <select value={rackId} onChange={(e) => setRackId(e.target.value)} disabled={racks.length === 0}>
                        <option value="">{racks.length ? 'Choose a rack' : 'No racks'}</option>
                        {racks.map((r) => (
                            <option key={r.id} value={r.id}>
                                {r.name} {r.room ? `· ${r.room}` : ''}
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    Colour by
                    <select value={colourBy} onChange={(e) => setColourBy(e.target.value as ColourBy)}>
                        <option value="stage">Lifecycle stage</option>
                        <option value="customer">Customer</option>
                        <option value="risk">EoX / coverage risk</option>
                    </select>
                </label>
            </section>
            {detail && (
                <section className="faces">
                    {(['front', 'rear'] as const).map((face) => (
                        <div key={face} className="face">
                            <h2>
                                {detail.rack.name} · {face}
                            </h2>
                            <ol className="units">
                                {rackElevation(
                                    detail.rack.units,
                                    detail.devices.map((d) => ({ assetId: d.tag || d.serial, ruStart: d.ruStart, height: d.height, face: d.face })),
                                    face,
                                ).map((row) => {
                                    const device = row.assetId ? byId.get(row.assetId) : undefined
                                    return (
                                        <li key={row.unit} className={device ? 'device' : 'empty'} style={{ ['--span' as string]: row.span, ...(device ? { background: colour(device) } : {}) }}>
                                            <span className="unit">{row.unit}</span>
                                            {device && (
                                                <a href={`/alm_hardware.do?sys_id=${device.id}`} target="_blank" rel="noreferrer" title={`${device.serial} · ${device.stage}`}>
                                                    {device.tag || device.serial} · {device.model}
                                                </a>
                                            )}
                                        </li>
                                    )
                                })}
                            </ol>
                        </div>
                    ))}
                </section>
            )}
        </main>
    )
}
