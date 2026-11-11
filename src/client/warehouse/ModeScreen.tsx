import { CircleCheckIcon, CircleXIcon } from 'lucide-react'
import { useRef, type KeyboardEvent } from 'react'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import Label from './Label'
import ScanField from './ScanField'
import { useStation, type ContextField, type Entry, type ModeSpec } from './station'

const TEXT_FIELDS: Record<Exclude<ContextField, 'stockroom'>, { label: string; placeholder: string; trim: boolean }> = {
    pid: { label: 'PID (only for units without an ASN)', placeholder: 'e.g. C9300-48P-E', trim: false },
    orderNumber: { label: 'Order number', placeholder: 'NORD0001000', trim: true },
    auditNumber: { label: 'Audit number', placeholder: 'NAUD0001000', trim: true },
}

/** One mode's screen: its context fields, the scan field, the scan log and the labels to print. Only the labels print. */
export function ModeScreen({ mode }: { mode: ModeSpec }) {
    const station = useStation()
    const scanInput = useRef<HTMLInputElement>(null)
    const focusScan = () => scanInput.current?.focus()
    const enterToScan = (event: KeyboardEvent) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        focusScan()
    }

    return (
        <>
            {mode.fields.length > 0 && (
                <FieldGroup className="print:hidden">
                    {mode.fields.map((name) => {
                        if (name === 'stockroom') {
                            const items = station.stockrooms.map((s) => ({ value: s.id, label: s.name }))
                            return (
                                <Field key={name}>
                                    <FieldLabel htmlFor="stockroom">Stockroom</FieldLabel>
                                    <Select
                                        items={items}
                                        value={station.context.stockroom || null}
                                        onValueChange={(value) => station.setContext('stockroom', value ?? '')}
                                        onOpenChangeComplete={(open) => open || focusScan()}
                                    >
                                        <SelectTrigger id="stockroom" className="w-full data-[size=default]:h-11">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {items.map((item) => (
                                                <SelectItem key={item.value} value={item.value}>
                                                    {item.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </Field>
                            )
                        }
                        const { label, placeholder, trim } = TEXT_FIELDS[name]
                        return (
                            <Field key={name}>
                                <FieldLabel htmlFor={name}>{label}</FieldLabel>
                                <Input
                                    id={name}
                                    className="h-11"
                                    value={station.context[name]}
                                    onChange={(e) => station.setContext(name, trim ? e.target.value.trim() : e.target.value)}
                                    onKeyDown={enterToScan}
                                    placeholder={placeholder}
                                    autoComplete="off"
                                />
                            </Field>
                        )
                    })}
                </FieldGroup>
            )}

            <ScanField label={mode.prompt} onScan={(code) => station.scan(mode.id, code)} pending={station.pending} inputRef={scanInput} />

            <ScanLog entries={station.log} />

            {station.labels.length > 0 && (
                <Card className="print:bg-transparent print:py-0 print:ring-0">
                    <CardHeader className="print:hidden">
                        <CardTitle>Labels to print ({station.labels.length})</CardTitle>
                        <CardAction className="flex gap-2">
                            <Button onClick={() => window.print()}>Print</Button>
                            <Button variant="outline" onClick={station.clearLabels}>
                                Clear
                            </Button>
                        </CardAction>
                    </CardHeader>
                    <CardContent className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2 print:px-0">
                        {station.labels.map((asset) => (
                            <Label key={asset.id} asset={asset} />
                        ))}
                    </CardContent>
                </Card>
            )}
        </>
    )
}

/** Newest first. Each entry is one line of the server's words, so a list of alerts reads better than a grid of one column. */
function ScanLog({ entries }: { entries: readonly Entry[] }) {
    return (
        <div role="log" aria-live="polite" className="flex flex-col gap-1.5 print:hidden">
            {entries.map((entry) => (
                <Alert key={entry.id} role={undefined} variant={entry.ok ? 'default' : 'destructive'}>
                    {entry.ok ? <CircleCheckIcon /> : <CircleXIcon />}
                    <AlertTitle className="font-normal">{entry.message}</AlertTitle>
                </Alert>
            ))}
        </div>
    )
}
