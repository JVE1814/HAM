import { fieldsOf, type Stage } from '../domain/lifecycle'

/** A sample record for a query under test: its field values by the names the query uses ('' or left out for blank). */
export type SampleRecord = Readonly<Record<string, string>>

/**
 * An Asset in `stage` as the instance stores it (its install status and substatus), with `fields` beside them: a
 * sample record for `recordMatches`. A boolean field is written as a query compares it: 'true' or 'false'.
 */
export function assetIn(stage: Stage, fields: SampleRecord = {}): SampleRecord {
    const { installStatus, substatus } = fieldsOf(stage)
    return { install_status: installStatus, substatus: substatus ?? '', ...fields }
}

/** `record` as a query reads it through a reference from another table: every field under `via` (`asset.`). */
export function through(via: string, record: SampleRecord, own: SampleRecord = {}): SampleRecord {
    return { ...Object.fromEntries(Object.entries(record).map(([field, value]) => [`${via}${field}`, value])), ...own }
}
