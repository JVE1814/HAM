import React, { useCallback, useEffect, useState } from 'react'
import type { AssetSummary, Stockroom } from '../../server/domain/rest-contracts'
import { stageText } from '../stage'
import { warehouseApi } from './api'
import Label from './Label'
import ScanField from './ScanField'

type Mode = 'receive' | 'putaway' | 'pick' | 'audit' | 'lookup'

/** `depot`: stockroom work, for inventory techs only (a field tech audits and looks up). */
const MODES: Array<{ id: Mode; title: string; prompt: string; depot?: true }> = [
    { id: 'receive', title: 'Receive', prompt: 'Scan the serial of each arriving unit', depot: true },
    { id: 'putaway', title: 'Put away', prompt: 'Scan the asset, it moves to the selected stockroom', depot: true },
    { id: 'pick', title: 'Pick', prompt: 'Scan each asset for the order', depot: true },
    { id: 'audit', title: 'Audit', prompt: 'Scan every unit you can see (blind count / site audit)' },
    { id: 'lookup', title: 'Look up', prompt: 'Scan any serial, provider tag or customer tag' },
]

interface Entry {
    ok: boolean
    message: string
}

/** What the scans of a mode are made against: the Stockroom chosen, the Order or Audit number typed, the PID typed. */
interface ScanContext {
    stockroom: string
    orderNumber: string
    auditNumber: string
    pid: string
}

/** What a scan answered: the unit as it now stands, or, for an audit scan, which is blind, only that the code was counted. */
type Scanned = { mode: Exclude<Mode, 'audit'>; asset: AssetSummary } | { mode: 'audit'; code: string }

export default function App() {
    const [mode, setMode] = useState<Mode>('receive')
    const [stockrooms, setStockrooms] = useState<Stockroom[]>([])
    const [depotWork, setDepotWork] = useState(true)
    const [stockroom, setStockroom] = useState('')
    const [orderNumber, setOrderNumber] = useState('')
    const [auditNumber, setAuditNumber] = useState('')
    const [pid, setPid] = useState('')
    const [busy, setBusy] = useState(false)
    const [log, setLog] = useState<Entry[]>([])
    const [labels, setLabels] = useState<AssetSummary[]>([])

    useEffect(() => {
        warehouseApi
            .stockrooms()
            .then((list) => {
                if (!list) {
                    // Not an inventory tech: only Audit and Look up are offered.
                    setDepotWork(false)
                    setMode((m) => (MODES.find((d) => d.id === m)?.depot ? 'audit' : m))
                    return
                }
                setStockrooms(list)
                if (list.length > 0) setStockroom(list[0].id)
            })
            .catch((error: Error) => setLog((l) => [{ ok: false, message: error.message }, ...l]))
    }, [])

    const onScan = useCallback(
        async (code: string) => {
            setBusy(true)
            try {
                const scanned = await perform(mode, code, { stockroom, orderNumber, auditNumber, pid })
                setLog((l) => [{ ok: true, message: describe(scanned) }, ...l].slice(0, 50))
                if (scanned.mode === 'receive' && scanned.asset.providerTag) setLabels((current) => [scanned.asset, ...current])
                setPid('')
            } catch (error) {
                setLog((l) => [{ ok: false, message: `${code}: ${(error as Error).message}` }, ...l].slice(0, 50))
            } finally {
                setBusy(false)
            }
        },
        [mode, stockroom, orderNumber, auditNumber, pid],
    )

    const current = MODES.find((m) => m.id === mode)!
    const modes = depotWork ? MODES : MODES.filter((m) => !m.depot)
    return (
        <main className="warehouse">
            <header>
                <h1>NaaS Warehouse</h1>
                <nav>
                    {modes.map((m) => (
                        <button key={m.id} className={m.id === mode ? 'active' : ''} onClick={() => setMode(m.id)}>
                            {m.title}
                        </button>
                    ))}
                </nav>
            </header>

            <section className="context">
                {(mode === 'receive' || mode === 'putaway') && (
                    <label className="field">
                        Stockroom
                        <select value={stockroom} onChange={(e) => setStockroom(e.target.value)}>
                            {stockrooms.map((s) => (
                                <option key={s.id} value={s.id}>
                                    {s.name}
                                </option>
                            ))}
                        </select>
                    </label>
                )}
                {mode === 'receive' && (
                    <label className="field">
                        PID (only for units without an ASN)
                        <input value={pid} onChange={(e) => setPid(e.target.value)} placeholder="e.g. C9300-48P-E" />
                    </label>
                )}
                {mode === 'audit' && (
                    <label className="field">
                        Audit number
                        <input value={auditNumber} onChange={(e) => setAuditNumber(e.target.value.trim())} placeholder="NAUD0001000" />
                    </label>
                )}
                {mode === 'pick' && (
                    <label className="field">
                        Order number
                        <input value={orderNumber} onChange={(e) => setOrderNumber(e.target.value.trim())} placeholder="NORD0001000" />
                    </label>
                )}
            </section>

            <ScanField label={current.prompt} onScan={onScan} busy={busy} />

            <ul className="log" aria-live="polite">
                {log.map((entry, i) => (
                    <li key={i} className={entry.ok ? 'ok' : 'error'}>
                        {entry.message}
                    </li>
                ))}
            </ul>

            {labels.length > 0 && (
                <section className="labels">
                    <div className="labels-header">
                        <h2>Labels to print ({labels.length})</h2>
                        <button onClick={() => window.print()}>Print</button>
                        <button onClick={() => setLabels([])}>Clear</button>
                    </div>
                    <div className="label-sheet">
                        {labels.map((asset) => (
                            <Label key={asset.id} asset={asset} />
                        ))}
                    </div>
                </section>
            )}
        </main>
    )
}

async function perform(mode: Mode, code: string, context: ScanContext): Promise<Scanned> {
    switch (mode) {
        case 'receive':
            return { mode, asset: await warehouseApi.receive({ code, stockroom: context.stockroom, pid: context.pid || undefined }) }
        case 'putaway':
            return { mode, asset: await warehouseApi.putAway({ code, stockroom: context.stockroom }) }
        case 'pick':
            if (!context.orderNumber) throw new Error('Enter the order number first')
            return { mode, asset: await warehouseApi.pick({ code, order: context.orderNumber }) }
        case 'audit':
            if (!context.auditNumber) throw new Error('Enter the audit number first')
            await warehouseApi.auditScan({ audit: context.auditNumber, code })
            return { mode, code }
        case 'lookup':
            return { mode, asset: await warehouseApi.lookup(code) }
    }
}

function describe(scanned: Scanned): string {
    if (scanned.mode === 'audit') return `${scanned.code} counted`
    const { asset } = scanned
    const name = `${asset.serial} (${asset.pid || asset.model})`
    switch (scanned.mode) {
        case 'receive':
            return `Received ${name} as ${asset.providerTag}${asset.orderLine ? `, allocated to ${asset.orderLine}` : ''}`
        case 'putaway':
            return `${name} put away in ${asset.stockroom}`
        case 'pick':
            return `${name} picked`
        case 'lookup':
            return `${name}: ${stageText(asset.stage)}, ${asset.stockroom || asset.customer || 'no location'}${asset.providerTag ? `, tag ${asset.providerTag}` : ''}`
    }
}
