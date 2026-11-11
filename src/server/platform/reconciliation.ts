import { GlideRecord } from '@servicenow/glide'
import { fleetStagesQuery } from '../domain/fleet.ts'
import {
    CI_SITE_LOCATIONS,
    MONITORING_EXCEPTION_TYPES,
    outOfUseExceptionsQuery,
    outsideFleetExceptionsQuery,
    reconcileAsset,
    seenWithoutFleetAssetQuery,
    stillSeenWithoutFleetAssetQuery,
} from '../domain/reconciliation.ts'
import { runTableJob } from './chunked.ts'
import { daysAgoGlide, glideToMs, nowMs } from './clock.ts'
import { cisWithOpenException, openException, resolveExceptions, resolveExceptionsWhere, settleExceptions } from './exceptions.ts'
import { intProperty } from './properties.ts'
import { PROPERTY } from '../domain/properties.ts'
import { pluck, str } from './records.ts'
import { IN_USE_STAGES } from '../domain/lifecycle.ts'

/** Reconciliation of the installed base with what monitoring reports (P2.7). */

/**
 * Compare installed fleet assets with monitoring; open new exceptions and resolve cleared ones. The Provider IT's
 * equipment in use (laptops, printers) is in service by its install status too, and is left out (ADR 0016): a
 * monitoring exception open on an Asset outside the fleet (raised before the Fleet flag) is resolved, as are one on a
 * fleet asset no longer in use and a *seen without asset* one whose CI no longer matches.
 */
export function reconcileInstalledBase(): void {
    const unseenDays = intProperty(PROPERTY.unseenDays)
    const now = nowMs()
    runTableJob({
        job: 'reconcile_installed_base',
        table: 'alm_hardware',
        query: fleetStagesQuery(IN_USE_STAGES),
        read: (asset) => ({
            customerId: str(asset, 'company'),
            view: {
                serial: str(asset, 'serial_number'),
                siteId: str(asset, 'x_daas_ham_site'),
                lastSeenAt: glideToMs(str(asset, 'x_daas_ham_last_seen')),
                ci: str(asset, 'ci')
                    ? {
                          serial: str(asset, 'ci.serial_number'),
                          locationIds: CI_SITE_LOCATIONS.map((location) => str(asset, `ci.${location}`)),
                      }
                    : undefined,
            },
        }),
        handle: (asset, assetId) => {
            const found = reconcileAsset(asset.view, now, unseenDays).map((type) => ({ type, detail: type.replace(/_/g, ' ') }))
            settleExceptions({ assetId }, asset.customerId, MONITORING_EXCEPTION_TYPES, found)
        },
    })
    resolveExceptionsWhere(outsideFleetExceptionsQuery(MONITORING_EXCEPTION_TYPES))
    resolveExceptionsWhere(outOfUseExceptionsQuery(MONITORING_EXCEPTION_TYPES))
    resolveClearedSeenWithoutAsset()
    reportSeenWithoutAsset(unseenDays)
}

/**
 * Resolve the open *seen without asset* exceptions whose CI `stillSeenWithoutFleetAssetQuery` leaves out: it points at a
 * fleet asset now, is not at a customer Site (the Provider IT's own gear, reported before the Fleet flag), or is gone.
 */
function resolveClearedSeenWithoutAsset(): void {
    const reported = cisWithOpenException(['seen_without_asset'])
    const query = stillSeenWithoutFleetAssetQuery(reported)
    if (!query) return
    const still = new Set(pluck('cmdb_ci_netgear', query, 'sys_id'))
    for (const ciId of reported) if (!still.has(ciId)) resolveExceptions({ ciId }, ['seen_without_asset'])
}

/** The most CIs one run reports: each costs an exception lookup, and the run has no cursor to go on from. */
const SEEN_WITHOUT_ASSET_PER_RUN = 1000

/** Network CIs recently discovered at a customer Site that no fleet asset points at (`seenWithoutFleetAssetQuery`). */
function reportSeenWithoutAsset(days: number): void {
    const ci = new GlideRecord('cmdb_ci_netgear')
    ci.addQuery('last_discovered', '>=', daysAgoGlide(days))
    ci.addEncodedQuery(seenWithoutFleetAssetQuery())
    ci.setLimit(SEEN_WITHOUT_ASSET_PER_RUN)
    ci.query()
    while (ci.next()) {
        const detail = `${str(ci, 'name')} (${str(ci, 'serial_number')}) is monitored at a Site but is no fleet asset`
        openException('seen_without_asset', { ciId: ci.getUniqueValue() }, { customerId: str(ci, 'company'), detail })
    }
}
