import { GlideRecord } from '@servicenow/glide'
import { formatProviderTag } from '../domain/provider-tag'
import { intProperty, PROPERTY, stringProperty } from './properties'

const SEQUENCE_JOB = 'provider_tag_sequence'

/**
 * The next Provider tag. The counter lives in x_daas_ham_job_cursor; receiving is low-concurrency,
 * and a clash would only produce a duplicate label, which the unique serial still disambiguates.
 */
export function nextProviderTag(): string {
    const counter = new GlideRecord('x_daas_ham_job_cursor')
    if (!counter.get('job', SEQUENCE_JOB)) {
        counter.initialize()
        counter.setValue('job', SEQUENCE_JOB)
        counter.setValue('cursor', '0')
        counter.insert()
    }
    const next = (parseInt(String(counter.getValue('cursor') ?? '0'), 10) || 0) + 1
    counter.setValue('cursor', String(next))
    counter.update()
    return formatProviderTag(stringProperty(PROPERTY.tagPrefix, 'NAAS'), next, intProperty(PROPERTY.tagDigits, 7))
}
