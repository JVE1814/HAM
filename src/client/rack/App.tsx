import React, { useEffect, useMemo, useState } from 'react'
import { devicePlacement, rackElevation, type PowerBudget } from '../../server/domain/rack'
import type { AssetStage, RackDevice, RackElevation, RackListing, Site } from '../../server/domain/rest-contracts'
import { supportRisk, type SupportRisk } from '../../server/domain/support-risk'
import { PROVIDER_STAFF } from '../../server/domain/roles'
import { RACK_FACE_CHOICES, type RackFace } from '../../server/domain/vocabulary'
import { stageText } from '../stage'
import { rackApi } from './api'

type ColourBy = 'stage' | 'customer' | 'risk'

const STAGE_COLOURS: Partial<Record<AssetStage, string>> = {
    in_service: 'var(--ok)',
    pending_in_service: 'var(--warn)',
    temporary_deployment: 'var(--accent)',
}

const RISK_COLOURS: Record<SupportRisk, string> = { high: 'var(--error)', medium: 'var(--warn)', low: 'var(--ok)' }

const FACES = Object.keys(RACK_FACE_CHOICES) as RackFace[]

function hashColour(text: string): string {
    let hash = 0
    for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) | 0
    return `hsl(${Math.abs(hash) % 360} 55% 45%)`
}

/**
 * The roles that open an Asset's form: provider staff, which alm_hardware's read ACLs admit (domain/visibility
 * PROVIDER_STAFF, the list the metadata's `providerStaff` is). Customer admins and site contacts are external users
 * (snc_external) the platform UI does not open for, so their rack shows no link.
 */
const STAFF_ROLES = PROVIDER_STAFF.join(',')

/**
 * Whether the user may open an Asset's form, read from g_user, which the page's sdk:now-ux-globals tag defines (admin
 * passes every role check). Only decides whether a link is shown: the ACLs still guard the form. No g_user, no link.
 */
function opensAssetForms(): boolean {
    const user = (window as { g_user?: { hasRoleFromList?: (roles: string) => boolean } }).g_user
    return user?.hasRoleFromList?.(STAFF_ROLES) ?? false
}

function latest<T>(load: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void, fail: (message: string) => void): () => void {
    const controller = new AbortController()
    load(controller.signal).then(
        (value) => {
            if (!controller.signal.aborted) apply(value)
        },
        (e: Error) => {
            if (!controller.signal.aborted) fail(e.message)
        },
    )
    return () => controller.abort()
}

export default function App() {
    const [sites, setSites] = useState<Site[]>([])
    const [siteId, setSiteId] = useState('')
    const [racks, setRacks] = useState<RackListing[]>([])
    const [rackId, setRackId] = useState('')
    const [detail, setDetail] = useState<RackElevation | null>(null)
    const [colourBy, setColourBy] = useState<ColourBy>('stage')
    const [error, setError] = useState('')
    const [linkAssets] = useState(opensAssetForms)
    const today = new Date().toISOString().slice(0, 10)

    useEffect(() => latest(rackApi.sites, setSites, setError), [])
    useEffect(() => {
        setRacks([])
        setRackId('')
        setError('')
        if (!siteId) return
        return latest((signal) => rackApi.racks(siteId, signal), setRacks, setError)
    }, [siteId])
    useEffect(() => {
        setDetail(null)
        setError('')
        if (!rackId) return
        return latest((signal) => rackApi.rack(rackId, signal), setDetail, setError)
    }, [rackId])

    // Keyed by sys_id, as the elevation's rows are: two devices can share a tag, or have neither a tag nor a serial.
    const byId = useMemo(() => new Map((detail?.devices ?? []).map((d) => [d.id, d])), [detail])
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
                                {rackElevation(detail.rack.units, detail.devices.map(devicePlacement), face).map((row) => {
                                    const device = row.assetId ? byId.get(row.assetId) : undefined
                                    return (
                                        <li key={row.unit} className={device ? 'device' : 'empty'} style={{ ['--span' as string]: row.span, ...(device ? { background: colour(device) } : {}) }}>
                                            <span className="unit">{row.unit}</span>
                                            {device &&
                                                (linkAssets ? (
                                                    <a href={`/alm_hardware.do?sys_id=${device.id}`} target="_blank" rel="noreferrer" title={`${device.serial} · ${stageText(device.stage)}`}>
                                                        {row.label} · {device.model}
                                                    </a>
                                                ) : (
                                                    <span className="device-name" title={`${device.serial} · ${stageText(device.stage)}`}>
                                                        {row.label} · {device.model}
                                                    </span>
                                                ))}
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
