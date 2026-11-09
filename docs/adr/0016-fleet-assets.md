# Fleet assets are flagged on the shared asset table

The platform tables the app builds on (ADR 0001) are shared with the Provider's own IT: `alm_hardware`,
`alm_stockroom`, `cmdb_model`, `cmn_location` and `core_company` hold the IT department's laptops, storerooms and
models beside the network equipment. The app acts only on its own equipment, the Fleet assets, and tells each kind of
record apart explicitly:

- **Asset**: the boolean `alm_hardware.x_daas_ham_fleet` (label *Fleet*, default false, indexed, read-only on forms).
  Nothing is back-filled: every row from before the column is outside the fleet until it is adopted.
- **Stockroom**: its `x_daas_ham_stockroom_type` (central depot, staging centre, customer site). A stockroom with no
  type is the Provider IT's, not a NaaS stockroom; stock in one is neither central stock nor received or put away there.
- **Model**: its `x_daas_ham_oem_pid`. A Model without an OEM PID is not a NaaS Model.

A Customer, a Site and a Lessor are told apart as before: an account in `customer_account`, a location with
`x_daas_ham_is_site`, a company a lease names.

The flag is set by every path through which the app creates or takes in a unit, and by nothing else on a form:

- every Asset the app creates, through `platform/assets` `newAsset`: an ASN row, a first scan received without an
  ASN, the demo data (which also flags a demo unit it loaded before the column existed);
- a receipt in the warehouse app of a unit outside the fleet that awaits receipt (on order or in transit, as
  Procurement creates the units of a purchase order), when it could be adopted: it joins the fleet with the
  receipt's save. Any other unit outside the fleet that a receipt finds is refused as the Provider IT's, and its
  serial is never given a second Asset;
- **Add to fleet**, a UI action on the Asset form and list for asset managers and administrators, offered on an
  Asset not yet in the fleet. It saves the form first, then adopts the Asset when `domain/fleet` `adoptionProblem`
  allows it: a NaaS Model, and on order, in transit, available in a NaaS stockroom, or in service with its Site and
  Agreement. Any other stage carries context the app sets as it goes (an Order line, a Spare pool, a Staging task, a
  return, a disposal), which an adopted unit lacks. Adoption sets the flag, and a blank Legal owner to the Provider,
  and nothing else: it moves no stage and opens no Service interval.

The column defaults that stamped a NaaS value on every row the Provider's IT creates are gone: an Asset's Legal owner
(once *Provider*, and a dropdown without *None*, which a form saved), a Model's *Track as asset* (once true) and a
Stockroom's type (once *Central depot*). The app's intake paths set those values instead (`newAsset` and adoption set
the Legal owner; the demo data sets the others), and a blank Legal owner still counts as the Provider's.

## Consequences

- `domain/fleet` is the one module that names the flag and builds the queries that keep a read to fleet assets,
  NaaS stockrooms and NaaS Models. A query on `alm_hardware` with `^NQ` clauses carries the fleet condition in each
  (`inFleet`, `fleetStagesQuery`), as a condition appended after `^NQ` binds to the last clause only.
- The fleet is not filtered by a before-query rule. Such a rule can only append conditions, so it cannot constrain
  every `^NQ` branch of a query it is handed, and it would hide the Provider IT's equipment from IT's own users and
  processes. Each app read filters for itself.
- `platform/assets` `findAssetByIdentifier` finds fleet assets only, so the warehouse look-up, put-away, pick and
  the device-events API (where another identifier is reported unknown) never act on IT's units. A receipt, and the
  serial check before an Asset is created, look at every Asset (`includeNonFleet`), so one physical unit never gets a
  second record; an ASN row for a serial any Asset carries is refused as before.
- The app's business rules on `alm_hardware` act on fleet assets only: each condition tests the flag after its change
  test and before it loads a module (ADR 0002 and the 254-character condition limit).
- Every Asset, Model and Stockroom reference on the app's tables and catalog items (a case's *Failed asset*, an Order
  line's Model, an Audit's Stockroom, a return request's Assets, ...) carries a reference qualifier that holds
  `domain/fleet`'s condition, so its picker offers fleet assets, NaaS Models or NaaS stockrooms only, also on a column
  the app itself writes, as a user editing the record can change it. The workspace lists, the dashboard and the
  navigator modules on those tables carry the condition in every `^NQ` clause too. Fluent metadata cannot call
  `domain/fleet`, so these are literals: `fleet-queries.test.ts` checks each against it, and fails on a reference or
  query added without one.
- Adoption puts a racked unit's placement into its rack as the rack checks count it (they count fleet assets only), so
  *Add to fleet* is checked as placing the unit there (D67): one that would overlap a fleet asset on its face, leave
  the rack or take it over its power budget is refused with the placement's reason, and stays outside the fleet.
- A unit Procurement receives through its own receiving slips, never scanned in the warehouse app, stays outside the
  fleet until it is adopted.
- Leaving the fleet is not offered: a unit leaves by disposal and keeps its flag, so its history stays the app's. A
  unit taken in by mistake is corrected by an administrator.
- Adopting a unit in service does not start its billing, which starts on a go-live (ADR 0009).
- Dropping the column defaults stops new values only. On an instance where an earlier version was installed, they were
  written on every row that existed then and on each one created since without a value, and they stay: the Provider
  IT's storerooms count as central depots, its hardware has the Legal owner *Provider*, and its Models are tracked as
  assets. The install does not clear them, as a stamped IT storeroom has the same values as a NaaS central depot; an
  administrator clears them by hand ([Fleet after an upgrade](../verify-on-instance.md#fleet-after-an-upgrade)). On
  the development instance, 9 of its 12 stockrooms were the platform's own IT warehouses stamped *Central depot*.
