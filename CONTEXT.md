# NaaS Hardware Asset Management

The language of a Network-as-a-Service provider that supplies, installs, runs, replaces and refreshes
network equipment at its customers' sites and bills it as a service.

## Language

### Parties and places

**Provider**:
The NaaS company operating this application and (usually) owning the equipment.
_Avoid_: MSP, vendor, us

**Customer**:
An organisation that subscribes to the Provider's network services; represented by a CSM account.
_Avoid_: client, tenant, company (except when naming the platform field)

**Customer admin**:
A person at the Customer who orders, raises faults, approves off-catalog requests and attests inventory.
_Avoid_: customer IT, requester

**Site contact**:
A person at one of the Customer's Sites who confirms deliveries and installs and handles self-installs.
_Avoid_: local contact, end user

**Site**:
A Customer location where equipment is installed (branch, campus, data centre).
_Avoid_: location (too generic), premises

**Room**:
A space inside a Site that holds equipment, such as an MDF, IDF or data-centre hall.
_Avoid_: closet, cabinet

**Rack**:
A frame in a Room whose rack units hold equipment.

**Power budget**:
The power a Rack can supply, set against the typical power of the Models placed in it.
_Avoid_: power draw (measured, not budgeted)

**Lessor**:
A financier that legally owns leased equipment the Provider uses.
_Avoid_: leasing company, bank

### Equipment

**Asset**:
The tracked record of one serialised physical piece of equipment across its whole life. The application acts only on Fleet assets; the Provider's own IT equipment shares the same records and is left alone.
_Avoid_: device (for the record), CI, hardware

**Fleet asset**:
An Asset the Provider runs as part of the network service, from receipt or ASN through staging, install, spares, returns and disposal. An Asset becomes one when the application creates or receives it, or when an asset manager adds existing equipment to the fleet.
_Avoid_: NaaS asset, managed device

**Chassis**:
An Asset that is a complete network device (switch, AP, router, firewall).

**FRU**:
A serialised field-replaceable unit (module, supervisor, power supply) tracked as a child of its Chassis.
_Avoid_: component, part

**Stack member**:
A Chassis that operates as one unit of a switch stack; tracked individually.

**Optic**:
A transceiver or cable counted as stock quantities rather than tracked individually, unless its Model is marked track-as-asset.
_Avoid_: SFP (one kind of Optic), consumable

**Model**:
The canonical product an Asset is an instance of, identified by its OEM PID.
_Avoid_: product, SKU, part number

**OEM PID**:
The manufacturer's product identifier for a Model (e.g. a Cisco product ID).

**Device class**:
The functional category of a Model (switch, AP, router, firewall, module, PSU, optic).

**Model category**:
The platform's classification of a Model (e.g. Network Gear), which decides the asset and CI class of its units; Procurement buys no Model without one.
_Avoid_: device class (the application's own category)

**Configuration item**:
The monitored/discovered representation of an Asset in the CMDB.
_Avoid_: CI (in prose), device

**Provider tag**:
The barcode identifier the Provider prints and attaches to an Asset at receiving.
_Avoid_: asset tag (ambiguous), label

**Customer tag**:
An optional identifier a Customer assigns to an Asset in its own numbering scheme.

**Legal owner**:
Who owns an Asset: the Provider, the Customer, or a Lessor.
_Avoid_: owner (ambiguous with assigned person)

### Lifecycle

**Lifecycle stage**:
Where an Asset is in its life (e.g. available, staging, in service, pending return), expressed through the platform's install status and substatus.
_Avoid_: state, status (alone)

**Lifecycle phase**:
Where a Model is in its manufacturer's support life: available, end of sale, end of support, end of extended support, end of life.
_Avoid_: EoX status, EOL (when meaning the phase in general)

**In service**:
An Asset installed at a Site and seen by monitoring; the moment billing starts.
_Avoid_: live, active, deployed

**Seen signal**:
Evidence from Discovery, a connector or the Provider's NMS that an Asset is alive on the network.
_Avoid_: heartbeat, ping

**Refresh due date**:
The date by which an in-service Asset must be replaced, from the Agreement's refresh cycle or its Model's end of support.

### Commercial

**Agreement**:
The commercial contract between the Provider and a Customer that sets terms, quantities, service levels and the one currency it bills in.
_Avoid_: contract (also used for leases and OEM coverage), subscription

**Renewal**:
Extending an Agreement's end date by its renewal term before it ends.
_Avoid_: extension (used for leases)

**Contracted quantity**:
How many Assets of a Device class or Model an Agreement allows to be deployed.
_Avoid_: quota, entitlement

**Subscription line**:
A billable service line of an Agreement (a site package or a device-class line) that delivering Assets are attached to.
_Avoid_: service line, billing line (one charge of a Billing period), subscription

**Catalog entry**:
A Model or Site template a Customer may order under its Agreement.
_Avoid_: approved model list, customer catalog

**Site template**:
A named bill of materials describing the standard equipment for a kind of Site.
_Avoid_: BOM, bundle, kit

**Spare pool**:
In-stock Assets of one Model reserved for one Customer's replacements, sized from all of the Customer's deployed Assets of that Model across their Agreements, each Agreement's spare-pool ratio applied to its own Assets.
_Avoid_: spares, buffer stock

**Fee event**:
A one-off charge to a Customer for a lost, damaged or late-returned Asset.
_Avoid_: penalty, surcharge

### Fulfilment

**Order**:
A request to deliver equipment to a Site: a site rollout, a device add or a device replace.
_Avoid_: request, RITM, ticket

**Order line**:
One Model and quantity within an Order, carried through sourcing, staging, delivery and install.

**Sourcing**:
Choosing where an Order line's Assets come from: the Customer's Spare pool, a customer-site stockroom, a central depot, or a purchase.
_Avoid_: allocation, fulfilment

**Stockroom**:
A place holding stock: a central depot, a staging centre or a customer-site stockroom. A stockroom of none of these types is the Provider's own IT's, not a NaaS stockroom, and the application leaves it alone.
_Avoid_: warehouse (one kind of Stockroom)

**Transfer order**:
A move of stock from one Stockroom to another, one line per Asset, worked by the platform's Inventory. An Asset on an open line is in transfer, a Lifecycle stage of its own, until Inventory lets it go.
_Avoid_: stock move, shipment (a carrier consignment)

**ASN**:
An advance shipment notice from a distributor listing serials in transit for a purchase order.

**Staging**:
Preparing an Asset before shipment (golden firmware, base config, licensing, controller claim, burn-in, label).
_Avoid_: imaging, provisioning, prep

**Staging source**:
Whether an Asset is staged in-house or pre-staged by the distributor (which then only needs verification).

**OEM claim**:
A Staging step the manufacturer's cloud carries out: claiming, registering, subscribing or zero-touch provisioning a device into the Customer's OEM cloud account.
_Avoid_: onboarding, activation

**OEM cloud account**:
A Customer's organization, subscription, FortiManager or template in a manufacturer's cloud that its devices are claimed into.
_Avoid_: tenant, org (alone)

**Shipment**:
A carrier consignment bought through the shipping aggregator, to a Site or back to the depot, with its tracking.
_Avoid_: parcel, delivery (the act)

**Install mode**:
How an Asset gets installed: FSM engineer, Customer self-install, subcontractor or data-centre remote hands.
_Avoid_: delivery method

**Maintenance window**:
The recurring time at a Site during which on-site changes may be carried out.

### After-sales

**Replacement order**:
An Order of type device replace raised from a case about a failed Asset, served from a hot spare, the Spare pool, stock, an OEM advance replacement or a purchase.
_Avoid_: RMA (that is the OEM's), break-fix ticket, swap

**Hot spare**:
Spare-pool stock kept in one of the Customer's customer-site stockrooms at a Site (or one of its Rooms), installed from there for a replacement at that Site.
_Avoid_: on-site spare

**OEM RMA**:
A return authorisation the Provider opens with the manufacturer for a defective Asset; a replacement sourced again reuses the one already open for its defective Asset rather than opening another.

**OEM coverage**:
The manufacturer support contract covering one Asset's serial number, with its service level and end date.
_Avoid_: warranty (one kind of coverage), SmartNet

**Refresh order**:
An Order of type refresh replacing Assets that reach their Refresh due date; the old Assets go back on a Return order.

**Return order**:
Bringing Assets back from a Site (decommission, removal, refresh swap-back, agreement end, defective return).
_Avoid_: reclamation, RMA

**Disposal order**:
Retiring Assets for good by resale, OEM takeback, recycling, or return to the Customer or Lessor.

**Wipe evidence**:
Proof that an Asset's configuration, keys and credentials were erased before it left the Provider's control. Evidence counts only if recorded since the Asset last came back from a Site or last entered Staging.

**Temporary deployment**:
An Order of type temporary: equipment installed for a fixed period (event, pop-up site, trial) whose Return order is raised automatically before the end date.
_Avoid_: loaner

**Audit**:
A check of what is physically present against what is expected, in a Stockroom (blind count) or at a Site.
_Avoid_: stocktake, inventory

**Attestation**:
A Customer admin's periodic confirmation of the Assets installed at their Sites.

**Reconciliation exception**:
A disagreement between Assets and monitoring (seen but unknown, deployed but unseen, serial or location mismatch), or between a Rack's placements and its units or Power budget (devices overlapping, over budget).

### Money

**Lease schedule**:
A financing contract with a Lessor covering a set of Assets until an end date.

**End-of-lease decision**:
The choice, due ahead of a Lease schedule's end, to buy its Assets out, extend it, or return them to the Lessor.

**Lease mismatch**:
A Lease schedule that ends while an Agreement its deployed Assets serve runs on (including an Agreement with no end date).

**Billing period**:
A calendar month of prorated Subscription line charges and Fee events, totalled per currency and locked once closed.
_Avoid_: invoice (issued by finance, not here)

**Billing line**:
One charge of a Billing period, in its Agreement's currency: a Subscription line at a Site, or one Fee event.
_Avoid_: invoice line

**Service interval**:
The days one Asset delivered a Subscription line, from the day it went in service to the day it left service.
_Avoid_: usage, billable period

**Cost fact**:
A cost of one kind (purchase write-off, lease, OEM support, field labour, shipping) attributed to a Customer and Site for one Billing period, in one currency.

**Margin**:
A Billing period's subscription and fee revenue minus its Cost facts, per Customer, Site and currency: amounts in two currencies are never added.
_Avoid_: profit, TCO (cost only)

## Avoided words kept in names

Some names users and the platform already see keep a word avoided above. Each means only what is said here, and the reason it stays follows.

- **entitlement**, in the Order's *Entitlement* verdict and *Entitlement findings*: the check of an Order against its Agreement's Catalog entries and Contracted quantities, never a quantity; the columns are installed, and renaming them means migrating their data.
- **over_quota**, the stored value of that verdict: its label reads *Over contracted quantity*, and a stored choice value cannot change without rewriting the Orders that hold it.
- **allocated**, in the Order line's `quantity_allocated`: the Assets an Order line holds, from whatever source; the column is installed.
- **warehouse**, in the warehouse app (*Warehouse scanning*, `x_daas_ham_warehouse.do`): the scanning page, used in every kind of Stockroom, not a kind of Stockroom; its URL is installed and linked.
- **device**, in what Customers and the NMS see (the customer page and its API's errors such as *Unknown device*, a *Device removal* return, device events): their word for one physical unit; they never work on the Asset form or in the platform's UI, and staff language keeps Asset.
