import { gs } from '@servicenow/glide'
import { PROPERTY, type PropertyOf } from '../domain/properties.ts'

/** An integer property; its declared value when it is unset or no number. */
export function intProperty(property: PropertyOf<number>): number {
    const value = parseInt(gs.getProperty(property.name, String(property.default)), 10)
    return Number.isFinite(value) ? value : property.default
}

/** A string property, trimmed; its declared value when it is unset, empty or only whitespace. */
export function stringProperty(property: PropertyOf<string>): string {
    return (gs.getProperty(property.name, property.default) || '').trim() || property.default
}

export function boolProperty(property: PropertyOf<boolean>): boolean {
    return gs.getProperty(property.name, String(property.default)) === 'true'
}

/**
 * A password2 property, as stored. Read with getProperty, which ignores the property's read roles: getPropertySecured
 * checks them against the session user, so it gives the default to the guest webhook and to every non-admin
 * (docs/research/external-contracts.md N45). The admin-only read role still keeps the record out of their UI.
 */
export function secretProperty(property: PropertyOf<string>): string {
    return gs.getProperty(property.name, property.default)
}

/** The staging centre's stockroom: where purchased units ship to, Assets are staged and shipments leave from ('' while none is set). */
export function stagingStockroom(): string {
    return stringProperty(PROPERTY.stagingStockroom)
}
