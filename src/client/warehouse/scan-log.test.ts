import { describe, expect, it } from 'vitest'
import { EMPTY_LOG, RECENT, scanLog, type ScanLog, type ScanLogAction } from './scan-log'

interface Scan {
    code: string
    order: string
}

const apply = (actions: ScanLogAction<Scan>[], from: ScanLog<Scan> = EMPTY_LOG): ScanLog<Scan> => actions.reduce(scanLog<Scan>, from)

const sent = (count: number): ScanLogAction<Scan>[] => Array.from({ length: count }, (_, i) => ({ type: 'sent', message: `m${i}` }))

const failed = (code: string): ScanLogAction<Scan> => ({ type: 'failed', scan: { code, order: 'NORD1' }, message: `${code}: refused` })

describe('scanLog', () => {
    it('shows the newest sent scan first and keeps only the newest 50', () => {
        const log = apply(sent(51))
        expect(log.sent.length).toBe(RECENT)
        expect(log.sent[0].message).toBe('m50')
        expect(log.sent.some((entry) => entry.message === 'm0')).toBe(false)
    })

    it('keeps every failed scan, however many scans follow it', () => {
        const log = apply([failed('BAD'), ...sent(60)])
        expect(log.failed).toEqual([{ id: 0, scan: { code: 'BAD', order: 'NORD1' }, message: 'BAD: refused' }])
    })

    it('keeps more than 50 failed scans, newest first', () => {
        const log = apply(Array.from({ length: 60 }, (_, i) => failed(`C${i}`)))
        expect(log.failed.length).toBe(60)
        expect(log.failed[0].scan).toEqual({ code: 'C59', order: 'NORD1' })
    })

    it('keeps the context a failed scan was scanned in', () => {
        const scan = { code: 'BAD', order: 'NORD1' }
        const log = apply([{ type: 'failed', scan, message: 'BAD: refused' }])
        expect(log.failed[0].scan).toBe(scan)
    })

    it('dismisses one failed scan by id and leaves the others', () => {
        const log = apply([failed('FIRST'), failed('SECOND')])
        const first = log.failed.find((failure) => failure.scan.code === 'FIRST')!
        const dismissed = scanLog(log, { type: 'dismissed', id: first.id })
        expect(dismissed.failed.map((failure) => failure.scan.code)).toEqual(['SECOND'])
        expect(scanLog(dismissed, { type: 'dismissed', id: 99 })).toEqual(dismissed)
    })

    it('dismisses all failed scans and keeps the sent ones', () => {
        const log = apply([failed('BAD'), ...sent(2), failed('WORSE')])
        const dismissed = scanLog(log, { type: 'dismissedAll' })
        expect(dismissed.failed).toEqual([])
        expect(dismissed.sent).toEqual(log.sent)
    })

    it('never reuses an id', () => {
        const log = apply([{ type: 'sent', message: 'ok' }, failed('BAD'), { type: 'dismissed', id: 1 }, failed('AGAIN')])
        const ids = [...log.sent, ...log.failed].map((entry) => entry.id)
        expect(new Set(ids).size).toBe(ids.length)
        expect(log.failed[0].id).toBe(2)
    })
})
