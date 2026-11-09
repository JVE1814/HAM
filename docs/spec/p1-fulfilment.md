# Inbound, staging, delivery and in service (P1.5–P1.8)

## Lifecycle stages (`domain/lifecycle.ts`, ADR 0002)

```text
on_order ─► in_transit ─► available ─► reserved ─► staging ─► staged ─► shipped
   ─► pending_in_service ─► in_service | temporary_deployment ─► pending_return
   ─► pending_evaluation ─► available | spare_pool | pending_oem_rma | pending_wipe
pending_oem_rma ─► returned_to_oem | pending_evaluation
pending_wipe ─► pending_disposal ─► disposed | sold | returned_to_oem | returned_to_customer | returned_to_lessor
```

- Going to a Site (shipped, pending in service, in service, temporary deployment) needs a Site and an
  Agreement.
- Leaving the Provider needs wipe evidence. Evidence counts only if it was recorded since the Asset
  last came back from a Site or last entered staging: receipt at the depot clears it, and so does
  every save into staging, since staging loads a Customer's configuration. That covers the app's moves
  and a stage set on the form by anyone, administrators included, or by a background process (the
  before-update rule on `alm_hardware` clears it).
- Leased Assets leave only to the Lessor, or to the OEM from pending OEM RMA (an OEM takeback from
  pending disposal is refused). Customer-owned Assets leave only back to the Customer.
- Form edits that break the matrix are refused; administrators and background processes are not
  checked (their moves into staging still clear the wipe evidence).

## Derived stages (`domain/fulfilment.ts`)

- A line follows its slowest Asset: sourced, staging, ready to ship, shipped, installed, in service.
  It is *awaiting stock* while fewer Assets than ordered are allocated.
- A unit that leaves while in transit (shipped, then missing or pending return) is taken off its
  line (logged). The line goes back to awaiting stock and is sourced again, with no new approval and
  its quantity unchanged. The exception is a whole-Site recovery (site decommission, agreement end):
  the unit stays on the line, which is not sourced again. A unit the platform refuses to take off
  the line also stays on it, and that line, like one that cannot be saved back to awaiting stock, is
  not sourced again (both logged).
- A unit that leaves after install (pending in service or later: a return, a break-fix swap of a
  dead-on-arrival unit, a refresh swap-back, a temporary Order's end, a decommission, declared
  missing) counts as delivered. A shipped line then only moves forward, following only the Assets
  still on their way into service (or in it), and a complete Order stays complete. A line whose
  every unit left before going into service keeps its stage. On a line sourced again, such a unit
  (on its way back, or received back) still counts toward the quantity and holds nothing up.
- While a line filled again waits, its Order is back in preparing (then delivering until Ship):
  *Ship* is offered again once the Order is delivering. *Confirm installed* stays offered for the
  units already shipped and confirms only those; the line filled again waits for its replacement
  unit, and so does the Asset that line replaces.
- A line's Assets are counted past the user's visibility rules (ADR 0005), so the stage does not
  depend on who moved an Asset (for example an inventory tech closing a Staging task while the hot
  spare sits in a customer-site stockroom).
- An Order follows its slowest live line: preparing, delivering (ready to ship), installing,
  complete. It is cancelled when every line is. Draft, awaiting-approval, rejected, cancelled and
  complete Orders keep their stage: a complete Order stays complete when its Assets leave service.
- A line or Order stage the platform refuses to save is logged: it is derived again only when one of
  its Assets next changes, and until then the line or Order keeps its old stage, with the actions
  that stage offers (Ship, Confirm installed).

## Inbound

- **ASN rows** create in-transit Assets (Provider-owned, company = Provider). They are refused if the
  serial already exists, the PID does not map to a Model (which records a normalization exception),
  or a mandatory field is missing. A row whose Asset insert the platform refuses is marked error with
  its reason. The check that no Asset has the serial sees every Asset, past the importer's stockroom
  rule (ADR 0005).
- Each row's Asset is created under the serial's job lock (`receive_serial_<serial>`), which a first
  scan without an ASN takes too, and the serial is checked again there. So a row and a scan of one
  serial create one Asset. A row that finds the lock held through 5 tries, or cannot take it, is
  marked error *serial <serial> not imported: ...; load this row again*. Loaded again, it imports, or
  is refused as a serial that already exists.
- **Warehouse app access**: Receive, Put away, Pick and the app's stockroom list are depot work, for
  inventory techs (asset managers and admins hold the role); anyone else gets HTTP 403 *Requires the
  inventory tech role*. Look up only reads the Asset and is open to inventory and field techs. Audit
  scans follow the audit rules (P2 assurance spec). A field tech is offered only Audit and Look up.
- **Receiving** (warehouse app) confirms only in-transit / on-order Assets as available in the chosen
  stockroom (for an inventory tech, one of theirs). It assigns the next Provider tag (unless the Asset
  has one). A unit whose ASN PO number is one of the *Purchase orders* of a line awaiting stock (same
  Model) is allocated to that line and comes off its *On order* count (reserved, then staging once its
  Staging task is created; without one, or when the move to staging is refused, it stays reserved and
  the reply shows it reserved). That holds while the line, read again under its lock, still awaits
  stock and has room; otherwise the unit is received as free stock (available) and the reply shows it
  unallocated. An unknown serial with a PID is received without an ASN. Returned units
  (pending return or missing) are received by the returns process (P2 after-sales spec); any other
  scanned Asset is refused as not awaiting receipt.
- The chosen stockroom must be a central depot or a staging centre: a customer-site stockroom is
  refused (HTTP 400), for returned units too.
- If the platform refuses to save the new or confirmed Asset, the call answers HTTP 422 and the unit is
  not received: it stays in transit or on order (one without an ASN may not be created at all), for a
  rescan. The reservation for the waiting line is a stock claim under the Asset's lock, as in
  sourcing (P1 ordering spec), so a sourcing run or the spare-pool top-up that claimed the received
  unit first keeps it, and the reply shows the unit as that run left it. If the reservation's save is
  refused, the unit stays received (available). Either way a warning is logged, no Staging task opens
  and the unit still comes off the line's *On order* count (or its RMA is marked received). The line
  is then a unit short, so the receipt queues the Order's sourcing again: a sourcing run may have
  picked the unit as free stock between the receipt's save and its reservation. The new pass sources
  the missing unit as usual, the received one among the free stock if it is still free.
- If the line's *On order* count, or the OEM RMA a replacement unit arrives for (P2 after-sales spec),
  cannot be saved, a warning is logged and the unit is still reserved for its line.
- **Provider tags** come from one counter, advanced under a job lock so that no two Assets share a tag.
  A receipt that cannot take the lock after 5 tries is told to scan again (HTTP 503) and the unit is
  not received; one without an ASN stays on order, so the rescan finds it by serial.
- Receipts of one unit are made under a job lock on the Asset (`receive_asset_<sys_id>`), from a
  fresh read. A scan of a unit another scan is still receiving saves nothing and answers HTTP 503
  *Another scan is receiving this unit: scan again*. The rescan finds it received and answers HTTP 409
  *Not awaiting receipt* (a returned unit is then pending evaluation). The overdue job takes the same
  lock to declare a unit missing (P2 after-sales spec).
- An unknown serial with a PID is created under a job lock on the serial (`receive_serial_<serial>`),
  re-checked there, so two first scans create one Asset. ASN rows take the same lock (above), so a
  scan and an ASN row of one serial create one Asset too. A scan that finds the lock held is told to
  scan again (HTTP 503), and the rescan finds the Asset by serial.
- A unit for a waiting line is saved, taken off its *On order* count (or its RMA marked received) and
  reserved under the line's job lock (`order_line_<sys_id>`, P1 ordering spec). So sourcing's count
  of the line (allocated, *On order*, OEM RMAs whose replacement is still to come) sees all of a
  receipt or none of it. A receipt that cannot take the lock after 10 tries saves nothing and
  answers HTTP 503 *Its order line is being sourced or received: scan again*. Under the line's lock
  the line is read again. The unit is allocated only while the line is still awaiting stock and has
  fewer Assets than its quantity. Otherwise it stays received as free stock (available), the line's
  *On order* count and any OEM RMA are left as they are, and a warning *Received <serial> left in
  stock, not given to <line>: ...* is logged.
- **Put-away** records the stockroom an Asset now sits in (for an inventory tech, one of theirs):
  - available stock and returned units awaiting evaluation, wipe or disposal go into any stockroom;
  - a unit being staged (one received for a waiting PO line among them) goes only into a staging
    centre;
  - reserved, spare-pool and staged Assets, and anything not in stock, are refused.

  A put-away the platform refuses to save answers HTTP 422 with its reason. It is made under the
  Asset's stock lock (`reserve_asset_<sys_id>`, P1 ordering spec), from a fresh read. So a unit a
  sourcing run or the spare-pool top-up claims meanwhile is refused (HTTP 409), and a scan that finds
  the lock held through 5 tries saves nothing and answers HTTP 503 *This unit is being reserved or
  moved: scan again*.
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

- **Ship** (Order delivering): needs a carrier and tracking number entered by hand, unless the
  shipping aggregator buys the label (P3 integrations spec), the mode is remote hands, or Ship only
  hands over hot spares. Staged Assets, and hot spares linked to the Order (handed over where they
  are, with no package), become shipped with the Order's Site and location. Assets the lifecycle
  refuses are reported and the others ship. Ship counts the Order's Assets whoever presses it (an
  inventory tech included). Ship on the Order form stops when the form's save is refused (the
  platform says why), so a tracking number typed but not saved is never used.
- For every mode except self-install, Ship opens a change and an FSM work order. A device replace
  uses a standard change; everything else uses a normal change.
- If the tracking number, or the change and work order, cannot be saved on the Order, Ship still
  ships and says so; the Shipment, change and work order name the Order, to link them by hand.
- Ship runs one at a time per Order, under a job lock on it (`ship_order_<sys_id>`), and reads the
  Order's tracking number and work order afresh. A Ship pressed while another of the same Order is
  running ships, buys and opens nothing and says another Ship is running. A Ship after it finds the
  units shipped and the work opened, so it buys no second label and opens no second change and work
  order. *Mark label voided* on one of the Order's outbound labels (P3 integrations spec) holds the
  same lock for a moment while it voids the label and clears it from the Order; a Ship pressed then
  says another Ship is running. *Cancel order* holds the same lock while it checks and releases the
  Order's lines (P1 ordering spec); a Ship pressed then says another Ship is running.
- After an outbound label is marked voided and cleared from the Order, the Order has no tracking
  number until the replacement's is typed. A Ship after that counts the typed number as entered by
  hand, so it buys no label for Assets staged since.
- After a line is filled again (above), a second Ship ships its new units. It uses the Order's
  tracking number when it was entered by hand (for one an earlier Ship bought, the shipping
  aggregator buys the new units a label of their own) and the Order's existing work order: it opens
  no second change or work order. *Confirm installed* stays offered meanwhile for the units already
  shipped.
- A work order's planned start and end must lie inside the change window (once scheduled) and the
  Site's maintenance schedule (if any).
- **Install completion** happens when the work order is closed complete or someone uses *Confirm
  installed* (Customer contacts only on self-install Orders; asset managers and field techs on any
  Order being installed). An Order is being installed when it is installing, or preparing or
  delivering with units already shipped: a line filled again holds it back in either, and units
  Ship refused hold it in delivering. The form's condition queries the Order's shipped Assets as
  the user, and the customer page applies the same rule (`domain/install-confirmation.ts`
  `beingInstalled`). Then:
  - only shipped Assets (hot spares handed over at Ship included) become pending in service with
    the install time; units not shipped yet, including a hot spare allocated but not handed over,
    wait for Ship;
  - the Asset a line replaces goes to pending return once that line's own replacement is installed
    (pending in service, in service or temporary).

  A unit the platform refuses to move stays where it was (logged), and so does its line: *Confirm
  installed* says how many, and the customer page's call (`POST /customer/orders/{id}/installed`)
  answers HTTP 422, so the confirmation can be sent again. An Asset whose replacement was refused
  stays in service until confirming again installs the replacement; the other lines' replaced Assets
  go to pending return at once. The refused unit stays shipped, so the Order keeps its stage
  (installing, or preparing or delivering while a line not shipped yet holds it back) and *Confirm
  installed* stays offered for the retry. *Confirm installed* on the Order form stops, like Ship,
  when the form's save is refused, so a Site typed but not saved is never used.

## In service and billing start

- Seen signals:
  - NMS events through `POST /api/x_daas_ham/naas/device_events`;
  - the Asset's CI `last_discovered`, read every 15 minutes for pending Assets.
- An Asset is in service at the first sighting at or after its install completion. A temporary Order
  gives a temporary deployment instead.
- At that moment:
  - the in-service date is set;
  - the Asset joins its Site's package line, or else the Agreement's line for its device class;
  - a pending line becomes active with its start date under a job lock on the line
    (`subscription_line_<sys_id>`), only while it is still pending when read again there. A line
    another go-live started is joined with its start date kept. One ended meanwhile, or whose lock
    another go-live holds through 5 tries, leaves the Asset pending in service (logged), and its
    next sighting chooses among the open lines;
  - the lifecycle phase and refresh due date are computed.
- Sightings of one Asset are applied one at a time under a job lock on it (`seen_asset_<sys_id>`),
  from a fresh read: last_seen only moves forward and only a still-pending Asset goes live. An NMS
  event that finds the lock held 10 times, or whose Asset save is refused (logged as an error), is
  not applied and is returned in `busy_identifiers`; the detection job leaves that Asset to its next
  run. A go-live whose save is refused after its Subscription line was started leaves the line
  active: the sighting applied again joins it, its start date kept.
- Device events store state changes only. They are purged after `x_daas_ham.events.retention_days`.
