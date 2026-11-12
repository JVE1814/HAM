import { useQuery } from '@tanstack/react-query'
import { createContext, use, useEffect, useState, type ReactNode } from 'react'
import type { AssetSummary, Stockroom } from '../../server/domain/rest-contracts'
import { stageText } from '../stage'
import { stockroomsQuery, warehouseApi } from './api'
import { scanQueue } from './scan-queue'

export type Mode = 'receive' | 'putaway' | 'pick' | 'audit' | 'lookup'

/** What a scan is done with, besides its code. */
export type ContextField = 'stockroom' | 'pid' | 'orderNumber' | 'auditNumber'

export interface ModeSpec {
    id: Mode
    title: string
    prompt: string
    /** Stockroom work, for inventory techs only (a field tech audits and looks up). */
    depot?: true
    fields: readonly ContextField[]
}

export const MODES: readonly ModeSpec[] = [
    { id: 'receive', title: 'Receive', prompt: 'Scan the serial of each arriving unit', depot: true, fields: ['stockroom', 'pid'] },
    { id: 'putaway', title: 'Put away', prompt: 'Scan the asset, it moves to the selected stockroom', depot: true, fields: ['stockroom'] },
    { id: 'pick', title: 'Pick', prompt: 'Scan each asset for the order', depot: true, fields: ['orderNumber'] },
    { id: 'audit', title: 'Audit', prompt: 'Scan every unit you can see (blind count / site audit)', fields: ['auditNumber'] },
    { id: 'lookup', title: 'Look up', prompt: 'Scan any serial, provider tag or customer tag', fields: [] },
]

/** The modes a user may use: `null` stockrooms is a field tech, refused depot work. */
export function modesFor(stockrooms: Stockroom[] | null | undefined): readonly ModeSpec[] {
    return stockrooms === null ? MODES.filter((m) => !m.depot) : MODES
}

type Context = Record<ContextField, string>

interface Scan extends Context {
    mode: Mode
    code: string
}

export interface Entry {
    id: number
    ok: boolean
    message: string
}

type Scanned = { mode: Exclude<Mode, 'audit'>; asset: AssetSummary } | { mode: 'audit'; code: string }

interface Station {
    stockrooms: Stockroom[]
    context: Context
    setContext: (field: ContextField, value: string) => void
    scan: (mode: Mode, code: string) => void
    pending: number
    log: readonly Entry[]
    labels: readonly AssetSummary[]
    clearLabels: () => void
}

const StationContext = createContext<Station | null>(null)

export function useStation(): Station {
    const station = use(StationContext)
    if (!station) throw new Error('useStation outside StationProvider')
    return station
}

/** The scanning state that outlives a mode switch: the context fields, the scan queue, its log and the labels. */
export function StationProvider({ children }: { children: ReactNode }) {
    const stockrooms = useQuery(stockroomsQuery).data ?? []
    const [chosen, setChosen] = useState<Context>({ stockroom: '', pid: '', orderNumber: '', auditNumber: '' })
    const [pending, setPending] = useState(0)
    const [log, setLog] = useState<Entry[]>([])
    const [labels, setLabels] = useState<AssetSummary[]>([])
    const context = { ...chosen, stockroom: chosen.stockroom || (stockrooms[0]?.id ?? '') }

    useEffect(() => {
        if (pending === 0) return
        const warn = (event: BeforeUnloadEvent) => event.preventDefault()
        window.addEventListener('beforeunload', warn)
        return () => window.removeEventListener('beforeunload', warn)
    }, [pending])

    // One queue for the page's life: each scan carries its own context, and the queue only sets state.
    const [queue] = useState(() => {
        let next = 0
        const record = (ok: boolean, message: string) => setLog((l) => [{ id: next++, ok, message }, ...l].slice(0, 50))
        return scanQueue<Scan>(async (scan) => {
            try {
                const scanned = await perform(scan)
                record(true, describe(scanned))
                if (scanned.mode === 'receive' && scanned.asset.providerTag) setLabels((current) => [scanned.asset, ...current])
            } catch (error) {
                record(false, `${scan.code}: ${(error as Error).message}`)
            }
        }, setPending)
    })

    const scan = (mode: Mode, code: string) => {
        queue({ ...context, mode, code, pid: mode === 'receive' ? context.pid.trim() : '' })
        // A PID is for the one unit scanned after it, whether that receive succeeds or fails: kept, it would go with the
        // next serial too, and an unknown (or shortened) serial with a PID is created as a new Asset of that Model.
        if (mode === 'receive') setChosen((c) => ({ ...c, pid: '' }))
    }

    const station: Station = {
        stockrooms,
        context,
        setContext: (field, value) => setChosen((c) => ({ ...c, [field]: value })),
        scan,
        pending,
        log,
        labels,
        clearLabels: () => setLabels([]),
    }
    return <StationContext value={station}>{children}</StationContext>
}

async function perform(scan: Scan): Promise<Scanned> {
    const { mode, code } = scan
    switch (mode) {
        case 'receive':
            return { mode, asset: await warehouseApi.receive({ code, stockroom: scan.stockroom, pid: scan.pid || undefined }) }
        case 'putaway':
            return { mode, asset: await warehouseApi.putAway({ code, stockroom: scan.stockroom }) }
        case 'pick':
            if (!scan.orderNumber) throw new Error('Enter the order number first')
            return { mode, asset: await warehouseApi.pick({ code, order: scan.orderNumber }) }
        case 'audit':
            if (!scan.auditNumber) throw new Error('Enter the audit number first')
            await warehouseApi.auditScan({ audit: scan.auditNumber, code })
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
