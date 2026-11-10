/**
 * A record an Order or a Return names, with the Customer it belongs to: '' for none (a Site template offered to every
 * Customer), null when it cannot be read.
 */
export interface NamedRecord {
    id: string
    customerId: string | null
}
