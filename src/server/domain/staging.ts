import type { StagingSource } from './vocabulary.ts'

/** Staging: choosing the checklist for an Asset and telling when it is done. */

/** How an Asset is staged when nothing says otherwise: by the Provider, in house. */
export const DEFAULT_STAGING_SOURCE: StagingSource = 'in_house'

export interface StagingTemplateView {
    id: string
    name: string
    customerId: string
    manufacturerId: string
    deviceClass: string
    source: StagingSource
    active: boolean
}

export interface StagingSubject {
    customerId: string
    manufacturerId: string
    deviceClass: string
    source: StagingSource
}

/** The most specific active template whose non-blank fields all match (customer > manufacturer > device class). */
export function selectStagingTemplate(templates: readonly StagingTemplateView[], subject: StagingSubject): string | null {
    const fits = (field: string, value: string) => field === '' || field === value
    const score = (t: StagingTemplateView) => (t.customerId ? 4 : 0) + (t.manufacturerId ? 2 : 0) + (t.deviceClass ? 1 : 0)
    const best = templates
        .filter(
            (t) =>
                t.active &&
                t.source === subject.source &&
                fits(t.customerId, subject.customerId) &&
                fits(t.manufacturerId, subject.manufacturerId) &&
                fits(t.deviceClass, subject.deviceClass),
        )
        .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))[0]
    return best?.id ?? null
}

export function stagingOutcome(steps: ReadonlyArray<{ mandatory: boolean; done: boolean }>): { complete: boolean; remaining: number } {
    const remaining = steps.filter((s) => s.mandatory && !s.done).length
    return { complete: remaining === 0, remaining }
}

/** The platform's task states a Staging task is closed with: Closed Complete once staged, Closed Skipped when its unit left staging. */
export const STAGING_TASK_STATE = { closed: 3, skipped: 7 } as const
