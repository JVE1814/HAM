import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { DataGrid, type GridColumn } from '@/components/data-grid'
import { required, useAppForm } from '@/components/form'
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import type { CustomerAsset, FaultReport, ReturnRequestReceipt } from '../../server/domain/rest-contracts'
import { stageText } from '../stage'
import { customerApi, overviewKey, overviewQuery } from './api'
import { useBusy } from './busy'
import { bySite } from './sites'

const returnable = (asset: CustomerAsset) => asset.stage !== 'pending_return'

const serialAndTag = (asset: CustomerAsset) => (asset.customerTag ? `${asset.serial} · ${asset.customerTag}` : asset.serial)

const PAGE_SIZE = 50

const columnsWith = (reportFault: (asset: CustomerAsset) => void): readonly GridColumn<CustomerAsset>[] => [
    {
        id: 'model',
        header: 'Device',
        value: (asset) => asset.model,
        cell: (asset) => (
            <div className="flex flex-col items-start gap-1 whitespace-normal">
                {asset.model}
                <span className="text-muted-foreground sm:hidden">{serialAndTag(asset)}</span>
                <StageBadge asset={asset} className="sm:hidden" />
            </div>
        ),
    },
    { id: 'serial', header: 'Serial / tag', value: serialAndTag, hideBelow: 'sm' },
    { id: 'stage', header: 'Status', value: (asset) => stageText(asset.stage), cell: (asset) => <StageBadge asset={asset} />, hideBelow: 'sm' },
    { id: 'refreshDue', header: 'Refresh due', value: (asset) => asset.refreshDue, hideBelow: 'md' },
    { id: 'fault', header: '', value: () => '', sortable: false, align: 'end', cell: (asset) => <FaultButton asset={asset} onReport={reportFault} /> },
]

function StageBadge({ asset, className }: { asset: CustomerAsset; className?: string }) {
    return (
        <Badge variant="secondary" className={className}>
            {stageText(asset.stage)}
        </Badge>
    )
}

export function Equipment() {
    const { data: overview } = useSuspenseQuery(overviewQuery)
    // The same arrays until the overview is read again: a grid goes back to its first page when its rows are a new array.
    const sites = useMemo(() => bySite(overview.assets), [overview.assets])
    const [fault, setFault] = useState<{ asset: CustomerAsset; open: boolean } | null>(null)
    const columns = useMemo(() => columnsWith((asset) => setFault({ asset, open: true })), [])
    if (sites.size === 0) {
        return (
            <Empty>
                <EmptyHeader>
                    <EmptyTitle>No equipment</EmptyTitle>
                </EmptyHeader>
            </Empty>
        )
    }
    return (
        <>
            {[...sites].map(([siteId, assets]) => (
                <Site key={siteId} siteId={siteId} assets={assets} admin={overview.isCustomerAdmin} columns={columns} />
            ))}
            {fault && <ReportFault key={fault.asset.id} asset={fault.asset} open={fault.open} onOpenChange={(open) => setFault({ asset: fault.asset, open })} />}
        </>
    )
}

function Site({
    siteId,
    assets,
    admin,
    columns,
}: {
    siteId: string
    assets: readonly CustomerAsset[]
    admin: boolean
    columns: readonly GridColumn<CustomerAsset>[]
}) {
    const site = assets[0].site
    const manages = admin && siteId !== ''
    return (
        <Card>
            <CardHeader>
                <CardTitle>{site || 'No site'}</CardTitle>
            </CardHeader>
            <CardContent>
                <DataGrid
                    caption={`Equipment at ${site || 'no site'}`}
                    columns={columns}
                    data={assets}
                    rowId={(asset) => asset.id}
                    pageSize={PAGE_SIZE}
                    search
                    selectable={manages ? returnable : undefined}
                    actions={
                        manages
                            ? (chosen, clear) => (
                                  <>
                                      <ReturnSelected siteId={siteId} chosen={chosen} clear={clear} />
                                      <DecommissionSite siteId={siteId} site={site} assets={assets} clear={clear} />
                                  </>
                              )
                            : undefined
                    }
                />
            </CardContent>
        </Card>
    )
}

function ReturnSelected({ siteId, chosen, clear }: { siteId: string; chosen: readonly CustomerAsset[]; clear: () => void }) {
    const busy = useBusy()
    const request = useMutation({
        mutationFn: customerApi.requestReturn,
        meta: { done: (r: ReturnRequestReceipt) => `Return ${r.returnOrder} requested`, refresh: [overviewKey] },
        onSuccess: clear,
    })
    return (
        <Button
            variant="outline"
            disabled={busy || chosen.length === 0}
            onClick={() => request.mutate({ site: siteId, assets: chosen.map((asset) => asset.id), decommission: false, method: 'ship_back' })}
        >
            Return selected ({chosen.length})
        </Button>
    )
}

function DecommissionSite({ siteId, site, assets, clear }: { siteId: string; site: string; assets: readonly CustomerAsset[]; clear: () => void }) {
    const busy = useBusy()
    const [open, setOpen] = useState(false)
    const decommission = useMutation({
        mutationFn: customerApi.requestReturn,
        meta: { done: (r: ReturnRequestReceipt) => `Decommission ${r.returnOrder} requested`, refresh: [overviewKey] },
        onSuccess: () => {
            clear()
            setOpen(false)
        },
    })
    return (
        <AlertDialog open={open} onOpenChange={setOpen}>
            <AlertDialogTrigger render={<Button variant="destructive" disabled={busy} />}>Decommission site</AlertDialogTrigger>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Decommission {site}?</AlertDialogTitle>
                    <AlertDialogDescription>All equipment there will be collected.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                        variant="destructive"
                        disabled={busy}
                        onClick={() => decommission.mutate({ site: siteId, assets: assets.map((asset) => asset.id), decommission: true, method: 'fsm_deinstall' })}
                    >
                        Decommission site
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    )
}

function FaultButton({ asset, onReport }: { asset: CustomerAsset; onReport: (asset: CustomerAsset) => void }) {
    const busy = useBusy()
    return (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onReport(asset)}>
            Report fault
        </Button>
    )
}

function ReportFault({ asset, open, onOpenChange }: { asset: CustomerAsset; open: boolean; onOpenChange: (open: boolean) => void }) {
    const busy = useBusy()
    const report = useMutation({
        mutationFn: (description: string) => customerApi.reportFault(asset.id, description),
        meta: { done: (r: FaultReport) => `Fault reported as ${r.case}`, refresh: [overviewKey] },
        onSuccess: () => {
            form.reset()
            onOpenChange(false)
        },
    })
    const form = useAppForm({
        defaultValues: { description: '' },
        // The MutationCache toasts a failure; the dialog stays open with the text typed.
        onSubmit: ({ value }) => report.mutateAsync(value.description.trim()).catch(() => undefined),
    })
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <form
                    className="flex flex-col gap-4"
                    onSubmit={(event) => {
                        event.preventDefault()
                        void form.handleSubmit()
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>Report fault</DialogTitle>
                    </DialogHeader>
                    <form.AppField name="description" validators={{ onSubmit: required('Say what is wrong') }}>
                        {(field) => <field.TextareaField label={`What is wrong with ${asset.model} ${asset.serial}?`} autoFocus />}
                    </form.AppField>
                    <DialogFooter>
                        <form.AppForm>
                            <form.SubmitButton disabled={busy}>Report fault</form.SubmitButton>
                        </form.AppForm>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    )
}
