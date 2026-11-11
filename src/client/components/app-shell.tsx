import { Link, Outlet, useLocation } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarInset,
    SidebarMenu,
    SidebarMenuBadge,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarProvider,
    SidebarTrigger,
} from '@/components/ui/sidebar'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

/** A destination of a page: the route path it opens, with its parameters filled in. */
export interface NavItem {
    label: string
    to: string
    badge?: number
}

export interface NavGroup {
    title?: string
    items: readonly NavItem[]
}

/**
 * The frame of every page: its title and its destinations. `sidebar` is for many destinations (the workspace's lists),
 * off-canvas on a phone; `tabs` for a few, on the phone-first pages. The current route renders below.
 */
export function AppShell({ title, layout, nav, actions }: { title: string; layout: 'sidebar' | 'tabs'; nav: readonly NavGroup[]; actions?: ReactNode }) {
    const { pathname } = useLocation()
    if (layout === 'sidebar') {
        return (
            <SidebarProvider>
                <Sidebar>
                    <SidebarHeader className="px-4 py-3 font-heading text-base font-semibold">{title}</SidebarHeader>
                    <SidebarContent>
                        {nav.map((group, i) => (
                            <SidebarGroup key={group.title ?? i}>
                                {group.title && <SidebarGroupLabel>{group.title}</SidebarGroupLabel>}
                                <SidebarMenu>
                                    {group.items.map((item) => (
                                        <SidebarMenuItem key={item.to}>
                                            <SidebarMenuButton isActive={pathname === item.to} render={<Link to={item.to} />}>
                                                {item.label}
                                            </SidebarMenuButton>
                                            {item.badge !== undefined && <SidebarMenuBadge>{item.badge}</SidebarMenuBadge>}
                                        </SidebarMenuItem>
                                    ))}
                                </SidebarMenu>
                            </SidebarGroup>
                        ))}
                    </SidebarContent>
                </Sidebar>
                <SidebarInset>
                    <header className="flex h-12 items-center gap-2 border-b px-4">
                        <SidebarTrigger className="-ml-1" />
                        <Separator orientation="vertical" className="h-4" />
                        <span className="truncate text-sm font-medium">{titleOf(nav, pathname) ?? title}</span>
                        <div className="ml-auto">{actions}</div>
                    </header>
                    <main className="flex flex-col gap-4 p-4">
                        <Outlet />
                    </main>
                </SidebarInset>
            </SidebarProvider>
        )
    }
    const items = nav.flatMap((group) => group.items)
    const current = items.find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`))
    return (
        <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4 print:max-w-none print:p-0">
            <header className="flex flex-wrap items-center gap-3 print:hidden">
                <h1 className="mr-auto font-heading text-xl font-semibold">{title}</h1>
                {actions}
            </header>
            {items.length > 1 && (
                <Tabs value={current?.to ?? null} className="print:hidden">
                    <TabsList className="max-w-full overflow-x-auto">
                        {items.map((item) => (
                            <TabsTrigger key={item.to} value={item.to} nativeButton={false} render={<Link to={item.to} />}>
                                {item.label}
                                {item.badge ? <Badge>{item.badge}</Badge> : null}
                            </TabsTrigger>
                        ))}
                    </TabsList>
                </Tabs>
            )}
            <main className="flex flex-col gap-4">
                <Outlet />
            </main>
        </div>
    )
}

function titleOf(nav: readonly NavGroup[], pathname: string): string | undefined {
    return nav.flatMap((group) => group.items).find((item) => item.to === pathname)?.label
}
