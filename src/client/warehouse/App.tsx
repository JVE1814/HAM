import React, { useCallback, useEffect, useState } from 'react'
import { warehouseApi, type AssetSummary, type Stockroom } from './api'
import Label from './Label'
import ScanField from './ScanField'

type Mode = 'receive' | 'putaway' | 'pick' | 'lookup'

const MODES: Array<{ id: Mode; title: string; prompt: string }> = [
    { id: 'receive', title: 'Receive', prompt: 'Scan the serial of each arriving unit' },
    { id: 'putaway', title: 'Put away', prompt: 'Scan the asset, it moves to the selected stockroom' },
    { id: 'pick', title: 'Pick', prompt: 'Scan each asset for the order' },
    { id: 'lookup', title: 'Look up', prompt: 'Scan any serial, provider tag or customer tag' },
]

interface Entry {
    ok: boolean
    message: string
    asset?: AssetSummary
}

export default function App() {
    const [mode, setMode] = useState<Mode>('receive')
    const [stockrooms, setStockrooms] = useState<Stockroom[]>([])
    const [stockroom, setStockroom] = useState('')
    const [order, setOrder] = useState('')
    const [pid, setPid] = useState('')
    const [busy, setBusy] = useState(false)
    const [log, setLog] = useState<Entry[]>([])
    const [labels, setLabels] = useState<AssetSummary[]>([])

    useEffect(() => {
        warehouseApi
            .stockrooms()
            .then((list) => {
                setStockrooms(list)
                if (list.length > 0) setStockroom(list[0].id)
            })
            .catch((error: Error) => setLog((l) => [{ ok: false, message: error.message }, ...l]))
    }, [])

    const onScan = useCallback(
        async (code: string) => {
            setBusy(true)
            try {
                const asset = await perform(mode, code, { stockroom, order, pid })
                setLog((l) => [{ ok: true, message: describe(mode, asset), asset }, ...l].slice(0, 50))
                if (mode === 'receive' && asset.providerTag) setLabels((current) => [asset, ...current])
                setPid('')
            } catch (error) {
                setLog((l) => [{ ok: false, message: `${code}: ${(error as Error).message}` }, ...l].slice(0, 50))
            } finally {
                setBusy(false)
            }
        },
        [mode, stockroom, order, pid],
    )

    const current = MODES.find((m) => m.id === mode)!
    return (
        <main className="warehouse">
            <header>
                <h1>NaaS Warehouse</h1>
                <nav>
                    {MODES.map((m) => (
                        <button key={m.id} className={m.id === mode ? 'active' : ''} onClick={() => setMode(m.id)}>
                            {m.title}
                        </button>
                    ))}
                </nav>
            </header>

            <section className="context">
                {(mode === 'receive' || mode === 'putaway') && (
                    <label>
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
                    <label>
                        PID (only for units without an ASN)
                        <input value={pid} onChange={(e) => setPid(e.target.value)} placeholder="e.g. C9300-48P-E" />
                    </label>
                )}
                {mode === 'pick' && (
                    <label>
                        Order number
                        <input value={order} onChange={(e) => setOrder(e.target.value.trim())} placeholder="NORD0001000" />
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

function perform(mode: Mode, code: string, context: { stockroom: string; order: string; pid: string }): Promise<AssetSummary> {
    switch (mode) {
        case 'receive':
            return warehouseApi.receive({ code, stockroom: context.stockroom, pid: context.pid || undefined })
        case 'putaway':
            return warehouseApi.putAway({ code, stockroom: context.stockroom })
        case 'pick':
            if (!context.order) return Promise.reject(new Error('Enter the order number first'))
            return warehouseApi.pick({ code, order: context.order })
        case 'lookup':
            return warehouseApi.lookup(code)
    }
}

function describe(mode: Mode, asset: AssetSummary): string {
    const name = `${asset.serial} (${asset.pid || asset.model})`
    switch (mode) {
        case 'receive':
            return `Received ${name} as ${asset.providerTag}${asset.orderLine ? `, allocated to ${asset.orderLine}` : ''}`
        case 'putaway':
            return `${name} put away in ${asset.stockroom}`
        case 'pick':
            return `${name} picked`
        case 'lookup':
            return `${name}: ${asset.stage}, ${asset.stockroom || asset.customer || 'no location'}${asset.providerTag ? `, tag ${asset.providerTag}` : ''}`
    }
}
