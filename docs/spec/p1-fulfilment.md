# Inbound, staging, delivery and in service (P1.5–P1.8)

## Lifecycle stages (`domain/lifecycle.ts`, ADR 0002)

```text
on_order ─► in_transit ─► available ─► reserved ─► staging ─► staged ─► shipped
   ─► pending_in_service ─► in_service | temporary_deployment ─► pending_return
   ─► pending_evaluation ─► available | spare_pool | pending_oem_rma | pending_wipe
pending_wipe ─► pending_disposal ─► disposed | sold | returned_to_oem | returned_to_customer | returned_to_lessor
```

- Going to a Site (shipped, pending in service, in service, temporary deployment) needs a Site and an
  Agreement.
- Leaving the Provider needs wipe evidence. Leased Assets leave only to the Lessor (or the OEM under
  RMA). Customer-owned Assets leave only back to the Customer.
- Form edits that break the matrix are refused; administrators and background processes are not
  checked.

## Derived stages (`domain/fulfilment.ts`)

- A line follows its slowest Asset: sourced, staging, ready to ship, shipped, installed, in service.
  It is *awaiting stock* while fewer Assets than ordered are allocated.
- An Order follows its slowest live line: preparing, delivering (ready to ship), installing,
  complete. It is cancelled when every line is.

## Inbound

- **ASN rows** create in-transit Assets (Provider-owned, company = Provider). They are refused if the
  serial already exists, the PID does not map to a Model (which records a normalization exception),
  or a mandatory field is missing.
- **Receiving** (warehouse app) confirms only in-transit / on-order Assets as available in the chosen
  stockroom (for an inventory tech, one of theirs). It assigns the next Provider tag (unless the Asset
  has one) and allocates the Asset to an Order line awaiting that PO (reserved, then staging once its
  Staging task is created; without one it stays reserved). An unknown serial with a PID is received
  without an ASN. Returned units (pending return or missing) are received by the returns process (P2
  after-sales spec); any other scanned Asset is refused as not awaiting receipt.
- The chosen stockroom must be a central depot or a staging centre: a customer-site stockroom is
  refused (HTTP 400), for returned units too.
- If the platform refuses to save the new or confirmed Asset, the call answers HTTP 422 and the unit is
  not received: it stays in transit or on order (one without an ASN may not be created at all), for a
  rescan. If only the reservation for the waiting line is refused, the unit stays received
  (available), a warning is logged and no Staging task opens.
- **Provider tags** come from one counter, advanced under a job lock so that no two Assets share a tag.
  A receipt that cannot take the lock after 5 tries is told to scan again (HTTP 503) and the unit is
  not received; one without an ASN stays on order, so the rescan finds it by serial.
- **Put-away** records the stockroom an Asset now sits in (for an inventory tech, one of theirs):
  - available stock and returned units awaiting evaluation, wipe or disposal go into any stockroom;
  - a unit being staged (one received for a waiting PO line among them) goes only into a staging
    centre;
  - reserved, spare-pool and staged Assets, and anything not in stock, are refused.
- **Pick** confirms an Asset is a staged Asset of the given Order.

## Staging

- The checklist is the most specific active template matching the Asset's Customer > manufacturer >
  device class and staging source. Distributor-staged Assets get verification templates.
- A Staging task is kept only with every step of its template. If the platform refuses a step, the task
  and its steps are removed (a task that cannot be deleted is named in a warning, to cancel) and the
  Asset stays reserved for its line.
- Steps stamp who and when. A task can be closed complete only when all mandatory steps are done,
  unless its result is *failed*. A failed Asset goes to pending evaluation and leaves the line.

## Delivery and install

- **Ship** (Order delivering): needs a tracking number unless the mode is remote hands. Staged Assets
  become shipped with the Order's Site and location.
- For every mode except self-install, Ship opens a change and an FSM work order. A device replace
  uses a standard change; everything else uses a normal change.
- A work order's planned start and end must lie inside the change window (once scheduled) and the
  Site's maintenance schedule (if any).
- **Install completion** happens when the work order is closed complete or someone uses *Confirm
  installed* (Customer contacts only on self-install Orders; asset managers and field techs on any
  Order being installed):
  - shipped Assets (and hot spares linked to the Order) become pending in service with the install
    time;
  - Assets replaced by the Order's lines go to pending return.

## In service and billing start

- Seen signals:
  - NMS events through `POST /api/x_daas_ham/naas/device_events`;
  - the Asset's CI `last_discovered`, read every 15 minutes for pending Assets.
- An Asset is in service at the first sighting at or after its install completion. A temporary Order
  gives a temporary deployment instead.
- At that moment:
  - the in-service date is set;
  - the Asset joins its Site's package line, or else the Agreement's line for its device class;
  - a pending line becomes active with its start date;
  - the lifecycle phase and refresh due date are computed.
- Device events store state changes only. They are purged after `x_daas_ham.events.retention_days`.
