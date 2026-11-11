import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRightIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, LabelList, Pie, PieChart, XAxis, YAxis } from 'recharts'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Failure } from '@/lib/app'
import { countQuery, fieldsQuery, sumQuery, type Tally } from '@/lib/sn'
import { cn } from '@/lib/utils'
import type { Widget } from './dashboard'

const SPAN = { 3: 'col-span-12 sm:col-span-6 xl:col-span-3', 4: 'col-span-12 lg:col-span-4', 6: 'col-span-12 lg:col-span-6', 12: 'col-span-12' } as const

export function WidgetCard({ widget }: { widget: Widget }) {
    return (
        <Card className={SPAN[widget.span]}>
            <CardHeader>
                <CardTitle>{widget.title}</CardTitle>
                {widget.drill && (
                    <CardAction>
                        <Button variant="ghost" size="icon-sm" aria-label={`Open the list of ${widget.title}`} nativeButton={false} render={<Link to="/lists/$listId" params={{ listId: widget.drill }} />}>
                            <ArrowRightIcon />
                        </Button>
                    </CardAction>
                )}
            </CardHeader>
            <CardContent>
                <WidgetBody widget={widget} />
            </CardContent>
        </Card>
    )
}

function WidgetBody({ widget }: { widget: Widget }) {
    switch (widget.chart) {
        case 'score':
            return <Score widget={widget} />
        case 'bar':
        case 'barh':
        case 'donut':
            return <CountChart widget={widget} />
        case 'currencyBar':
            return <CurrencyBar widget={widget} />
        case 'currencyMatrix':
            return <CurrencyMatrix widget={widget} />
    }
}

function Loaded<T>({ result, height, children }: { result: UseQueryResult<T>; height: string; children: (data: T) => ReactNode }) {
    if (result.error) return <Failure error={result.error} />
    if (!result.data) return <Skeleton className={cn('w-full', height)} />
    return children(result.data)
}

function Score({ widget }: { widget: Extract<Widget, { chart: 'score' }> }) {
    return (
        <Loaded result={useQuery(countQuery(widget.source))} height="h-10">
            {(tally) => <p className="font-heading text-4xl font-semibold tabular-nums">{(tally[0]?.count ?? 0).toLocaleString()}</p>}
        </Loaded>
    )
}

/** The `top` largest groups, and the rest as one "Others" when the widget asks for it. */
function topGroups(tally: Tally, top: number, others: boolean): Tally {
    const rest = tally.slice(top)
    const shown = tally.slice(0, top)
    return others && rest.length > 0 ? [...shown, { key: '', label: 'Others', count: rest.reduce((sum, group) => sum + group.count, 0) }] : shown
}

const COUNT: ChartConfig = { count: { label: 'Count', color: 'var(--chart-1)' } }

function CountChart({ widget }: { widget: Extract<Widget, { chart: 'bar' | 'barh' | 'donut' }> }) {
    return (
        <Loaded result={useQuery(countQuery(widget.source, widget.by))} height="h-64">
            {(tally) => {
                const groups = topGroups(tally, widget.top, widget.others)
                if (groups.length === 0) return <p className="text-sm text-muted-foreground">Nothing to count</p>
                if (widget.chart === 'donut') return <Donut groups={groups} />
                const horizontal = widget.chart === 'barh'
                return (
                    <ChartContainer config={COUNT} className="aspect-auto w-full" style={{ height: horizontal ? Math.max(160, groups.length * 28) : 256 }}>
                        <BarChart accessibilityLayer data={groups} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ left: 0, right: 16 }}>
                            <CartesianGrid vertical={horizontal} horizontal={!horizontal} />
                            {horizontal ? (
                                <>
                                    <XAxis type="number" allowDecimals={false} hide />
                                    <YAxis type="category" dataKey="label" width={140} tickLine={false} axisLine={false} />
                                </>
                            ) : (
                                <>
                                    <XAxis dataKey="label" tickLine={false} axisLine={false} interval={0} tickMargin={8} />
                                    <YAxis allowDecimals={false} width={32} tickLine={false} axisLine={false} />
                                </>
                            )}
                            <ChartTooltip content={<ChartTooltipContent />} />
                            <Bar dataKey="count" fill="var(--color-count)" radius={4} />
                        </BarChart>
                    </ChartContainer>
                )
            }}
        </Loaded>
    )
}

function Donut({ groups }: { groups: Tally }) {
    const slices = groups.map((group, i) => ({ ...group, slot: `g${i}`, fill: `var(--color-g${i})` }))
    const config: ChartConfig = Object.fromEntries(slices.map((slice, i) => [slice.slot, { label: slice.label, color: `var(--chart-${(i % 5) + 1})` }]))
    return (
        <ChartContainer config={config} className="mx-auto aspect-square max-h-72 w-full">
            <PieChart>
                <ChartTooltip content={<ChartTooltipContent nameKey="slot" hideLabel />} />
                <Pie data={slices} dataKey="count" nameKey="slot" innerRadius="55%" />
                <ChartLegend content={<ChartLegendContent nameKey="slot" />} className="flex-wrap" />
            </PieChart>
        </ChartContainer>
    )
}

/** An amount in its own currency; a currency field that holds no ISO code shows the code after the number. */
function money(amount: number, currency: string): string {
    try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount)
    } catch {
        return `${amount.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}`
    }
}

const AMOUNT: ChartConfig = { amount: { label: 'Amount', color: 'var(--chart-2)' } }

/** One bar per currency, labelled with its amount. No value axis: amounts of two currencies share no unit. */
function CurrencyBar({ widget }: { widget: Extract<Widget, { chart: 'currencyBar' }> }) {
    return (
        <Loaded result={useQuery(sumQuery(widget.source, widget.sum))} height="h-48">
            {(sums) =>
                sums.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Nothing billed</p>
                ) : (
                    <ChartContainer config={AMOUNT} className="aspect-auto h-48 w-full">
                        <BarChart accessibilityLayer data={[...sums].sort((a, b) => a.currency.localeCompare(b.currency))} margin={{ top: 24 }}>
                            <XAxis dataKey="currency" tickLine={false} axisLine={false} />
                            <Bar dataKey="amount" fill="var(--color-amount)" radius={4}>
                                <LabelList
                                    position="top"
                                    className="fill-foreground"
                                    valueAccessor={(entry: { payload: { amount: number; currency: string } }) => money(entry.payload.amount, entry.payload.currency)}
                                />
                            </Bar>
                        </BarChart>
                    </ChartContainer>
                )
            }
        </Loaded>
    )
}

const TINT = ['bg-chart-1/10', 'bg-chart-1/20', 'bg-chart-1/35', 'bg-chart-1/50', 'bg-chart-1/70']
const NEGATIVE_TINT = ['bg-destructive/10', 'bg-destructive/20', 'bg-destructive/35', 'bg-destructive/50', 'bg-destructive/70']

/** A cell's shade, measured against the largest amount of its own currency only. */
function tint(amount: number, largest: number): string {
    if (!largest || !amount) return ''
    const step = Math.min(TINT.length - 1, Math.floor((Math.abs(amount) / largest) * TINT.length))
    return (amount < 0 ? NEGATIVE_TINT : TINT)[step] ?? ''
}

function CurrencyMatrix({ widget }: { widget: Extract<Widget, { chart: 'currencyMatrix' }> }) {
    const by = useQuery(fieldsQuery(widget.source.table, [widget.by])).data?.[0]
    return (
        <Loaded result={useQuery(sumQuery(widget.source, widget.sum, widget.by))} height="h-64">
            {(sums) => {
                const currencies = [...new Set(sums.map((entry) => entry.currency))].sort()
                const rows = [...new Map(sums.map((entry) => [entry.key, entry.label])).entries()].sort(([, a], [, b]) => a.localeCompare(b))
                const largest = new Map(currencies.map((currency) => [currency, Math.max(...sums.filter((e) => e.currency === currency).map((e) => Math.abs(e.amount)))]))
                const cell = (key: string, currency: string) => sums.find((entry) => entry.key === key && entry.currency === currency)
                if (sums.length === 0) return <p className="text-sm text-muted-foreground">Nothing recorded</p>
                return (
                    <div className="max-h-80 overflow-y-auto">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{by?.label ?? widget.by}</TableHead>
                                    {currencies.map((currency) => (
                                        <TableHead key={currency} className="text-right">
                                            {currency}
                                        </TableHead>
                                    ))}
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.map(([key, label]) => (
                                    <TableRow key={key}>
                                        <TableCell>{label}</TableCell>
                                        {currencies.map((currency) => {
                                            const entry = cell(key, currency)
                                            return (
                                                <TableCell key={currency} className={cn('text-right tabular-nums', entry && tint(entry.amount, largest.get(currency) ?? 0))}>
                                                    {entry ? money(entry.amount, currency) : ''}
                                                </TableCell>
                                            )
                                        })}
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                )
            }}
        </Loaded>
    )
}
