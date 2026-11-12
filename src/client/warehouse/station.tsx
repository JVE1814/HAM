import { useQuery } from '@tanstack/react-query'
import { createContext, use, useEffect, useReducer, useState, type ReactNode } from 'react'
import type { AssetSummary, Stockroom } from '../../server/domain/rest-contracts'
import { stockroomsQuery } from './api'
import { EMPTY_LOG, scanLog, type Entry, type FailedScan, type ScanLog } from './scan-log'
import { scanQueue } from './scan-queue'
import { contextAfter, describe, perform, scanOf, type Context, type ContextField, type Mode, type Scan } from './scans'

interface Station {
    stockrooms: Stockroom[]
    context: Context
    setContext: (field: ContextField, value: string) => void
    scan: (mode: Mode, code: string) => void
    pending: number
    log: readonly Entry[]
    failed: readonly FailedScan<Scan>[]
    /** Sends a failed scan again as it was scanned. Never done for the operator: the server may have applied the first try. */
    rescan: (failure: FailedScan<Scan>) => void
    dismiss: (id: number) => void
    dismissAll: () => void
    labels: readonly AssetSummary[]
    clearLabels: () => void
}

const StationContext = createContext<Station | null>(null)

export function useStation(): Station {
    const station = use(StationContext)
    if (!station) throw new Error('useStation outside StationProvider')
    return station
}

/** The scanning state that outlives a mode switch: the context fields, the scan queue, its log, the failed scans and the labels. */
export function StationProvider({ children }: { children: ReactNode }) {
    const stockrooms = useQuery(stockroomsQuery).data ?? []
    const [chosen, setChosen] = useState<Context>({ stockroom: '', pid: '', orderNumber: '', auditNumber: '' })
    const [pending, setPending] = useState(0)
    const [log, record] = useReducer(scanLog<Scan>, EMPTY_LOG as ScanLog<Scan>)
    const [labels, setLabels] = useState<AssetSummary[]>([])
    const context = { ...chosen, stockroom: chosen.stockroom || (stockrooms[0]?.id ?? '') }

    useEffect(() => {
        if (pending === 0) return
        const warn = (event: BeforeUnloadEvent) => event.preventDefault()
        window.addEventListener('beforeunload', warn)
        return () => window.removeEventListener('beforeunload', warn)
    }, [pending])

    // One queue for the page's life: each scan carries its own context, and the queue only sets state.
    const [queue] = useState(() =>
        scanQueue<Scan>(async (scan) => {
            try {
                const scanned = await perform(scan)
                record({ type: 'sent', message: describe(scanned) })
                if (scanned.mode === 'receive' && scanned.asset.providerTag) setLabels((current) => [scanned.asset, ...current])
            } catch (error) {
                record({ type: 'failed', scan, message: `${scan.code}: ${(error as Error).message}` })
            }
        }, setPending),
    )

    const scan = (mode: Mode, code: string) => {
        queue(scanOf(context, mode, code))
        setChosen((chosen) => contextAfter(chosen, mode))
    }

    const station: Station = {
        stockrooms,
        context,
        setContext: (field, value) => setChosen((c) => ({ ...c, [field]: value })),
        scan,
        pending,
        log: log.sent,
        failed: log.failed,
        rescan: (failure) => {
            record({ type: 'dismissed', id: failure.id })
            queue(failure.scan)
        },
        dismiss: (id) => record({ type: 'dismissed', id }),
        dismissAll: () => record({ type: 'dismissedAll' }),
        labels,
        clearLabels: () => setLabels([]),
    }
    return <StationContext value={station}>{children}</StationContext>
}
