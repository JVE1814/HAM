/** On-site work must fall inside its change window and the Site's Maintenance window (Q57). */

export interface JobWindowFacts {
    jobStart: number
    jobEnd: number
    /** The change request's planned window, if it has been scheduled yet. */
    change?: { start: number; end: number }
    /** Whether both job start and end fall inside the Site's maintenance schedule (true if the Site has none). */
    inMaintenanceWindow: boolean
}

export type WindowVerdict = { ok: true } | { ok: false; reason: string }

export function checkJobWindow(facts: JobWindowFacts): WindowVerdict {
    if (facts.jobEnd < facts.jobStart) return { ok: false, reason: 'The work must end after it starts' }
    if (facts.change && (facts.jobStart < facts.change.start || facts.jobEnd > facts.change.end)) {
        return { ok: false, reason: 'The work must be scheduled inside the change window' }
    }
    if (!facts.inMaintenanceWindow) {
        return { ok: false, reason: "The work must be scheduled inside the site's maintenance window" }
    }
    return { ok: true }
}
