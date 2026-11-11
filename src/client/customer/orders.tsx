import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { DataGrid, type GridColumn } from '@/components/data-grid'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { CustomerOrder, CustomerReturn, InstallConfirmation } from '../../server/domain/rest-contracts'
import { customerApi, overviewKey, overviewQuery } from './api'
import { useBusy } from './busy'

const ORDER_COLUMNS: readonly GridColumn<CustomerOrder>[] = [
    {
        id: 'number',
        header: 'Order',
        value: (order) => order.number,
        cell: (order) => (
            <div className="flex flex-col">
                <span className="font-medium">{order.number}</span>
                <span className="text-muted-foreground sm:hidden">{order.stageLabel}</span>
            </div>
        ),
    },
    { id: 'type', header: 'Type', value: (order) => order.type, hideBelow: 'sm' },
    { id: 'site', header: 'Site', value: (order) => order.site, hideBelow: 'md' },
    { id: 'stage', header: 'Stage', value: (order) => order.stageLabel, hideBelow: 'sm' },
    { id: 'confirm', header: '', value: () => '', sortable: false, align: 'end', cell: (order) => order.canConfirmInstall && <ConfirmInstalled order={order} /> },
]

const RETURN_COLUMNS: readonly GridColumn<CustomerReturn>[] = [
    { id: 'number', header: 'Return', value: (ret) => ret.number, cell: (ret) => <span className="font-medium">{ret.number}</span> },
    { id: 'trigger', header: 'Reason', value: (ret) => ret.trigger, hideBelow: 'sm' },
    { id: 'site', header: 'Site', value: (ret) => ret.site, hideBelow: 'md' },
    { id: 'dueDate', header: 'Due back by', value: (ret) => ret.dueDate },
    {
        id: 'label',
        header: 'Return label',
        value: (ret) => ret.trackingNumber,
        sortable: false,
        cell: (ret) =>
            ret.labelUrl && (
                <span className="flex flex-col">
                    <Button variant="link" className="h-auto justify-start p-0 whitespace-normal" nativeButton={false} render={<a href={ret.labelUrl} target="_blank" rel="noreferrer" />}>
                        Print return label
                    </Button>
                    <span className="break-all whitespace-normal text-muted-foreground tabular-nums">{ret.trackingNumber}</span>
                </span>
            ),
    },
]

export function Orders() {
    const { data: overview } = useSuspenseQuery(overviewQuery)
    return (
        <>
            <Card>
                <CardHeader>
                    <CardTitle>Open orders</CardTitle>
                </CardHeader>
                <CardContent>
                    <DataGrid caption="Open orders" columns={ORDER_COLUMNS} data={overview.orders} rowId={(order) => order.id} empty="No open orders" />
                </CardContent>
            </Card>
            <Card>
                <CardHeader>
                    <CardTitle>Open returns</CardTitle>
                </CardHeader>
                <CardContent>
                    <DataGrid caption="Open returns" columns={RETURN_COLUMNS} data={overview.returns} rowId={(ret) => ret.number} empty="No open returns" />
                </CardContent>
            </Card>
        </>
    )
}

function ConfirmInstalled({ order }: { order: CustomerOrder }) {
    const busy = useBusy()
    const confirm = useMutation({
        mutationFn: () => customerApi.confirmInstalled(order.id),
        meta: { done: (r: InstallConfirmation) => `${r.order} confirmed installed`, refresh: [overviewKey] },
    })
    return (
        <Button size="sm" disabled={busy} onClick={() => confirm.mutate()}>
            Confirm installed
        </Button>
    )
}
