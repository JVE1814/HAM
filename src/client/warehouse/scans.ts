import type { AssetSummary, Stockroom } from '../../server/domain/rest-contracts'
import { stageText } from '../stage'
import { warehouseApi } from './api'

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

export type Context = Record<ContextField, string>

export interface Scan extends Context {
    mode: Mode
    code: string
}

export type Scanned = { mode: Exclude<Mode, 'audit'>; asset: AssetSummary } | { mode: 'audit'; code: string }

export function scanOf(context: Context, mode: Mode, code: string): Scan {
    return { ...context, mode, code, pid: mode === 'receive' ? context.pid.trim() : '' }
}

/**
 * The context fields once a scan is queued. A PID is for the one unit scanned after it, whether that receive
 * succeeds or fails: kept, it would go with the next serial too, and an unknown (or shortened) serial with a PID is
 * created as a new Asset of that Model.
 */
export function contextAfter(context: Context, mode: Mode): Context {
    return mode === 'receive' ? { ...context, pid: '' } : context
}

export async function perform(scan: Scan): Promise<Scanned> {
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

export function describe(scanned: Scanned): string {
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
