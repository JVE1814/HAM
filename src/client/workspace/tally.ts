import type { Tally } from '../lib/sn'

/** The `top` largest groups, the rest added up as one "Others" group when `others` asks for it. */
export function topGroups(tally: Tally, top: number, others: boolean): Tally {
    const rest = tally.slice(top)
    const shown = tally.slice(0, top)
    return others && rest.length > 0 ? [...shown, { key: '', label: 'Others', count: rest.reduce((sum, group) => sum + group.count, 0) }] : shown
}

const TINT = ['bg-chart-1/10', 'bg-chart-1/20', 'bg-chart-1/35', 'bg-chart-1/50', 'bg-chart-1/70']
const NEGATIVE_TINT = ['bg-destructive/10', 'bg-destructive/20', 'bg-destructive/35', 'bg-destructive/50', 'bg-destructive/70']

/** The background of a matrix cell: darker the nearer `amount` is to the column's `largest`, red below zero, none for zero. */
export function tint(amount: number, largest: number): string {
    if (!largest || !amount) return ''
    const step = Math.min(TINT.length - 1, Math.floor((Math.abs(amount) / largest) * TINT.length))
    return (amount < 0 ? NEGATIVE_TINT : TINT)[step] ?? ''
}
