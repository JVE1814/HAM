import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AttestationItem, CustomerAsset, CustomerOverview } from '../../server/domain/rest-contracts'
import { ATTESTATION_RESPONSE_CHOICES, type AttestationResponse } from '../../server/domain/vocabulary'
import { stageText } from '../stage'
import { customerApi } from './api'

type Tab = 'equipment' | 'orders' | 'attest'

export default function App() {
    const [overview, setOverview] = useState<CustomerOverview | null>(null)
    const [tab, setTab] = useState<Tab>('equipment')
    const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

    const load = useCallback(() => {
        customerApi
            .overview()
            .then(setOverview)
            .catch((e: Error) => setMessage({ ok: false, text: e.message }))
    }, [])
    useEffect(load, [load])

    const inFlight = useRef(false)
    const [busy, setBusy] = useState(false)
    const run: Runner = (action) => {
        if (inFlight.current) return
        inFlight.current = true
        setBusy(true)
        action()
            .then((text) => setMessage({ ok: true, text }))
            .catch((e: Error) => setMessage({ ok: false, text: e.message }))
            .finally(() => {
                inFlight.current = false
                setBusy(false)
                load()
            })
    }

    if (!overview) return <main className="customer">{message ? <p className="error">{message.text}</p> : <p>Loading…</p>}</main>

    const openAttestations = overview.attestations.length
    return (
        <main className="customer">
            <header>
                <h1>{overview.customer || 'My network equipment'}</h1>
                <nav>
                    <button className={tab === 'equipment' ? 'active' : ''} onClick={() => setTab('equipment')}>
                        Equipment ({overview.assets.length})
                    </button>
                    <button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>
                        Orders &amp; returns
                    </button>
                    {overview.isCustomerAdmin && (
                        <button className={tab === 'attest' ? 'active' : ''} onClick={() => setTab('attest')}>
                            Confirm equipment {openAttestations > 0 && <span className="badge">{openAttestations}</span>}
                        </button>
                    )}
                </nav>
            </header>
            {message && <p className={message.ok ? 'ok' : 'error'}>{message.text}</p>}
            {tab === 'equipment' && <Equipment overview={overview} run={run} busy={busy} />}
            {tab === 'orders' && <Orders overview={overview} run={run} busy={busy} />}
            {tab === 'attest' && <Attestations overview={overview} run={run} busy={busy} />}
        </main>
    )
}

type Runner = (action: () => Promise<string>) => void

interface ActionProps {
    overview: CustomerOverview
    run: Runner
    busy: boolean
}

const returnable = (asset: CustomerAsset) => asset.stage !== 'pending_return'

function Equipment({ overview, run, busy }: ActionProps) {
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const sites = useMemo(() => {
        const bySite = new Map<string, CustomerAsset[]>()
        for (const asset of overview.assets) bySite.set(asset.siteId, [...(bySite.get(asset.siteId) ?? []), asset])
        return [...bySite.values()]
    }, [overview.assets])

    const toggle = (id: string) =>
        setSelected((current) => {
            const next = new Set(current)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    const unselect = (ids: readonly string[]) =>
        setSelected((current) => {
            const next = new Set(current)
            for (const id of ids) next.delete(id)
            return next
        })

    return (
        <>
            {sites.map((assets) => {
                const siteId = assets[0].siteId
                const chosen = assets.filter((a) => returnable(a) && selected.has(a.id)).map((a) => a.id)
                return (
                    <section key={siteId} className="card">
                        <h2>{assets[0].site || 'No site'}</h2>
                        <table>
                            <thead>
                                <tr>
                                    {overview.isCustomerAdmin && <th />}
                                    <th>Device</th>
                                    <th>Serial / tag</th>
                                    <th>Status</th>
                                    <th>Refresh due</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {assets.map((asset) => (
                                    <tr key={asset.id}>
                                        {overview.isCustomerAdmin && (
                                            <td>
                                                {returnable(asset) && (
                                                    <input
                                                        type="checkbox"
                                                        checked={selected.has(asset.id)}
                                                        onChange={() => toggle(asset.id)}
                                                        aria-label={`Select ${asset.serial}`}
                                                    />
                                                )}
                                            </td>
                                        )}
                                        <td>{asset.model}</td>
                                        <td>
                                            {asset.serial}
                                            {asset.customerTag ? ` · ${asset.customerTag}` : ''}
                                        </td>
                                        <td>{stageText(asset.stage)}</td>
                                        <td>{asset.refreshDue}</td>
                                        <td>
                                            <button
                                                disabled={busy}
                                                onClick={() => {
                                                    const description = window.prompt(`What is wrong with ${asset.model} ${asset.serial}?`)
                                                    if (!description) return
                                                    run(() => customerApi.reportFault(asset.id, description).then((r) => `Fault reported as ${r.case}`))
                                                }}
                                            >
                                                Report fault
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {overview.isCustomerAdmin && siteId && (
                            <div className="actions">
                                <button
                                    disabled={busy || chosen.length === 0}
                                    onClick={() =>
                                        run(() =>
                                            customerApi.requestReturn({ site: siteId, assets: chosen, decommission: false, method: 'ship_back' }).then((r) => {
                                                unselect(chosen)
                                                return `Return ${r.returnOrder} requested`
                                            }),
                                        )
                                    }
                                >
                                    Return selected ({chosen.length})
                                </button>
                                <button
                                    className="danger"
                                    disabled={busy}
                                    onClick={() => {
                                        if (window.confirm(`Decommission ${assets[0].site}? All equipment there will be collected.`)) {
                                            const all = assets.map((a) => a.id)
                                            run(() =>
                                                customerApi
                                                    .requestReturn({ site: siteId, assets: all, decommission: true, method: 'fsm_deinstall' })
                                                    .then((r) => {
                                                        unselect(all)
                                                        return `Decommission ${r.returnOrder} requested`
                                                    }),
                                            )
                                        }
                                    }}
                                >
                                    Decommission site
                                </button>
                            </div>
                        )}
                    </section>
                )
            })}
        </>
    )
}

function Orders({ overview, run, busy }: ActionProps) {
    return (
        <>
            <section className="card">
                <h2>Open orders</h2>
                <ul className="rows">
                    {overview.orders.map((order) => (
                        <li key={order.id}>
                            <strong>{order.number}</strong> {order.type} · {order.site} · {order.stageLabel}
                            {order.canConfirmInstall && (
                                <button
                                    disabled={busy}
                                    onClick={() => run(() => customerApi.confirmInstalled(order.id).then((r) => `${r.order} confirmed installed`))}
                                >
                                    Confirm installed
                                </button>
                            )}
                        </li>
                    ))}
                    {overview.orders.length === 0 && <li>No open orders</li>}
                </ul>
            </section>
            <section className="card">
                <h2>Open returns</h2>
                <ul className="rows">
                    {overview.returns.map((ret) => (
                        <li key={ret.number}>
                            <strong>{ret.number}</strong> {ret.trigger} · {ret.site} · due back by {ret.dueDate}
                            {ret.labelUrl && (
                                <>
                                    {' · '}
                                    <a href={ret.labelUrl} target="_blank" rel="noreferrer">
                                        Print return label
                                    </a>{' '}
                                    ({ret.trackingNumber})
                                </>
                            )}
                        </li>
                    ))}
                    {overview.returns.length === 0 && <li>No open returns</li>}
                </ul>
            </section>
        </>
    )
}

const ANSWERS = Object.keys(ATTESTATION_RESPONSE_CHOICES) as AttestationResponse[]

function Attestations({ overview, run, busy }: ActionProps) {
    const [answers, setAnswers] = useState<Record<string, AttestationItem['response']>>({})
    if (overview.attestations.length === 0) return <section className="card">Nothing to confirm right now.</section>
    return (
        <>
            {overview.attestations.map((attestation) => {
                const items = attestation.items.map((item) => ({ ...item, response: answers[item.id] ?? item.response }))
                const complete = items.every((item) => item.response)
                return (
                    <section key={attestation.id} className="card">
                        <h2>
                            {attestation.number}: {attestation.site}
                        </h2>
                        <p>Is each of these devices at the site?</p>
                        <table>
                            <tbody>
                                {items.map((item) => (
                                    <tr key={item.id}>
                                        <td>{item.model}</td>
                                        <td>{item.serial}</td>
                                        <td>
                                            {ANSWERS.map((response) => (
                                                <label key={response} className="radio">
                                                    <input
                                                        type="radio"
                                                        name={item.id}
                                                        checked={item.response === response}
                                                        onChange={() => setAnswers((a) => ({ ...a, [item.id]: response }))}
                                                    />
                                                    {ATTESTATION_RESPONSE_CHOICES[response].label}
                                                </label>
                                            ))}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        <div className="actions">
                            <button
                                disabled={busy || !complete}
                                onClick={() =>
                                    run(() =>
                                        customerApi
                                            .answerAttestation(
                                                attestation.id,
                                                items.map((i) => ({ id: i.id, response: i.response })),
                                                true,
                                            )
                                            .then((r) => `${r.attestation} submitted, thank you`),
                                    )
                                }
                            >
                                Submit
                            </button>
                        </div>
                    </section>
                )
            })}
        </>
    )
}
