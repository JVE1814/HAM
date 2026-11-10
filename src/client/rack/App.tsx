import React, { useEffect, useMemo, useState } from 'react'
import { rackElevation, type PowerBudget } from '../../server/domain/rack'
import type { AssetStage, RackDevice, RackElevation, RackListing, Site } from '../../server/domain/rest-contracts'
import { supportRisk, type SupportRisk } from '../../server/domain/support-risk'
import { RACK_FACE_CHOICES, type RackFace } from '../../server/domain/vocabulary'
import { stageText } from '../stage'
import { rackApi } from './api'

type ColourBy = 'stage' | 'customer' | 'risk'

const STAGE_COLOURS: Partial<Record<AssetStage, string>> = {
    in_service: 'var(--ok)',
    pending_in_service: 'var(--warn)',
    pending_return: 'var(--neutral)',
    temporary_deployment: 'var(--accent)',
}

const RISK_COLOURS: Record<SupportRisk, string> = { high: 'var(--error)', medium: 'var(--warn)', low: 'var(--ok)' }

const FACES = Object.keys(RACK_FACE_CHOICES) as RackFace[]

function hashColour(text: string): string {
    let hash = 0
    for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) | 0
    return `hsl(${Math.abs(hash) % 360} 55% 45%)`
}

export default function App() {
    const [sites, setSites] = useState<Site[]>([])
    const [siteId, setSiteId] = useState('')
    const [racks, setRacks] = useState<RackListing[]>([])
    const [rackId, setRackId] = useState('')
    const [detail, setDetail] = useState<RackElevation | null>(null)
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
        colourBy === 'customer' ? hashColour(device.customer) : colourBy === 'risk' ? RISK_COLOURS[supportRisk(device, today)] : STAGE_COLOURS[device.stage] ?? 'var(--neutral)'

    return (
        <main className="racks">
            <h1>Rack elevations</h1>
            {error && <p className="error">{error}</p>}
            <section className="pickers">
                <label className="field">
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
                <label className="field">
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
                <label className="field">
                    Colour by
                    <select value={colourBy} onChange={(e) => setColourBy(e.target.value as ColourBy)}>
                        <option value="stage">Lifecycle stage</option>
                        <option value="customer">Customer</option>
                        <option value="risk">EoX / coverage risk</option>
                    </select>
                </label>
            </section>
            {detail && <PowerBar power={detail.rack.power} />}
            {detail && (
                <section className="faces">
                    {FACES.map((face) => (
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
                                                <a href={`/alm_hardware.do?sys_id=${device.id}`} target="_blank" rel="noreferrer" title={`${device.serial} · ${stageText(device.stage)}`}>
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

function PowerBar({ power }: { power: PowerBudget }) {
    if (power.utilisation === null) return <section className="power">Typical power {power.usedW} W (no rack capacity recorded)</section>
    const over = power.utilisation > 100
    return (
        <section className={over ? 'power over' : 'power'}>
            <span>
                Power {power.usedW} W of {power.capacityW} W ({power.utilisation}%)
            </span>
            <span className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(power.utilisation, 100)}>
                <span style={{ width: `${Math.min(power.utilisation, 100)}%` }} />
            </span>
        </section>
    )
}
