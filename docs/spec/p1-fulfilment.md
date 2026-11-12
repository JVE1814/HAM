# Inbound, staging, delivery and in service (P1.5–P1.8)

## Lifecycle stages (`domain/lifecycle.ts`, ADR 0002)

```text
on_order ─► in_transit ─► available ─► reserved ─► staging ─► staged ─► shipped
   ─► pending_in_service ─► in_service | temporary_deployment ─► pending_return
   ─► pending_evaluation ─► available | spare_pool | pending_oem_rma | pending_wipe
pending_oem_rma ─► returned_to_oem | pending_evaluation
pending_wipe ─► pending_disposal ─► disposed | sold | returned_to_oem | returned_to_customer | returned_to_lessor
available | reserved | spare_pool | staging ─► in_transfer ─► available | reserved | spare_pool | staging
```

- The app acts on Fleet assets only (ADR 0016): its rules on `alm_hardware` neither check nor change
  the stage of the Provider IT's equipment.
- Going to a Site (shipped, pending in service, in service, temporary deployment) needs a Site and an
  Agreement.
- Leaving the Provider needs wipe evidence. Evidence counts only if it was recorded since the Asset
  last came back from a Site or last entered staging: receipt at the depot clears it, and so does
  every save into staging, since staging loads a Customer's configuration. That covers the app's moves
  and a stage set on the form by anyone, administrators included, or by a background process (the
  before-update rule *NaaS - staging voids wipe evidence* on `alm_hardware` clears it).
- Leased Assets leave only to the Lessor, or to the OEM from pending OEM RMA (an OEM takeback from
  pending disposal is refused). Customer-owned Assets leave only back to the Customer.
- A stage set outside the app's moves that breaks the matrix, or that the app does not model, is
  refused when a user without `admin` saves it in their own transaction. That covers a form edit and
  also out-of-box logic the user's action runs, such as an inventory tech working a transfer order
  line (below). Administrators and background processes are not checked (their moves into staging
  still clear the wipe evidence). ADR 0002 used to say such changes were accepted unchecked; this
  spec and the code win.
- **In transfer** is an Asset on an open transfer order line between two stockrooms, stored as either
  of the combinations Inventory sets: *In stock / Pending transfer* (Draft, Requested, Shipment
  Preparation) and *In transit / Reserved* (In Transit) (ADR 0002, external-contracts N38).
  - An Asset goes into transfer only while Inventory has it on an open line, which it records in the
    Asset's *Active transfer order* flag in the same save: a user without `admin` cannot set either
    combination on the form of an Asset on no open line. It leaves transfer only once Inventory lets
    it go and clears the flag, back to available, reserved, spare pool or staging: a user without
    `admin` cannot free on the form a unit still on its way between two stockrooms. *Cancel order*
    takes a unit in transfer off its Order line and leaves it in transfer; it is free stock once
    Inventory lets it go.
  - Inventory takes onto a line only an Asset *In stock / Available*. A transfer order made by hand
    therefore moves free stock; the ones sourcing raises move units it reserved for an Order line
    (P1 ordering spec).
  - When Inventory lets the Asset go, it saves it *In stock / Available*: in the transfer order's
    to-stockroom once the line is received (*In stock / Reserved* for a line requested for a user),
    where it was when the line is cancelled or deleted (external-contracts N39). In that same save
    the Asset takes back the stage it left instead, as what it still carries shows. On an Order line
    it goes into staging once it is received at the staging centre with its Staging task open; at the
    staging centre without that task it stays reserved for the line. Held for a Customer (its company
    not the Provider), it goes back to the Customer's Spare pool. Otherwise it is free stock,
    available. The stockroom Inventory set is kept, and the lifecycle rule checks that move. An Asset
    that comes back into staging this way loses its wipe evidence, as on any move into staging.
  - A unit on an Order line that Inventory lets go anywhere but the staging centre (its line
    cancelled or deleted) is reserved for the line again where it was, and its transfer has fallen
    through: nothing would move it on from there. So it is then put back as free stock under the
    Provider company (the Source it was picked from is no longer known; the spare-pool top-up
    replaces a spare), its Staging task is skipped, and its line goes back to awaiting stock and is
    sourced again, which may pick the same unit and raise a new transfer order (a warning is logged;
    P1 ordering spec). A unit the platform refuses to put back stays reserved for its line (logged).
    The lines sourcing removes from a transfer order it could not complete are let go the same way,
    but sourcing puts those units back itself (P1 ordering spec).
  - A line received, or delivered, after its last task was closed skipped leaves the Asset in transfer
    with the flag cleared, for its stage to be set by hand.

## Derived stages (`domain/fulfilment.ts`)

- A line follows its slowest Asset: sourced, staging, ready to ship, shipped, installed, in service.
  It is *awaiting stock* while fewer Assets than ordered are allocated. A unit in transfer to the
  staging centre counts as sourced: on its way, not yet sent to the Site.
- A unit that leaves while in transit (shipped, then missing or pending return) is taken off its
  line (logged). The line goes back to awaiting stock and is sourced again, with no new approval and
  its quantity unchanged. The exception is a Return that ends the deployment (site decommission,
  agreement end, temporary end): the unit stays on the line, which is not sourced again. A unit the platform refuses to take off
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
- A line read afresh as cancelled, or on an Order cancelled or rejected, is never moved on by its
  Assets, and a line whose Order ended while its derived stage was saved is cancelled again (logged
  if refused): a stage derived beside a cancel never reopens a cancelled line (P1 ordering spec).

## Inbound

- **ASN rows** create in-transit Assets (Provider-owned, company = Provider). They are refused if the
  serial already exists, the PID does not map to a Model (which records a normalization exception),
  or a mandatory field is missing. A row whose Asset insert the platform refuses is marked error with
  its reason. The check that no Asset has the serial sees every Asset, past the importer's stockroom
  rule (ADR 0005).
- Each row's Asset is created under the serial's job lock (`LOCK.receiveSerial` in
  `domain/lock-names.ts`), which a first
  scan without an ASN takes too, and the serial is checked again there. So a row and a scan of one
  serial create one Asset. A row that finds the lock held through `LOCK_TRIES` tries
  (`domain/job-lock.ts`), or cannot take it, is
  marked error with the reason and told to load again (`platform/receiving.ts`). Loaded again, it
  imports, or
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
  the reply shows it reserved). That holds while the line, read again under its lock with its Order,
  still awaits stock and has room, on an Order neither cancelled nor rejected; otherwise the unit is
  received as free stock (available) and the reply shows it unallocated. An unknown serial with a PID is received without an ASN. Returned units
  (pending return or missing) are received by the returns process (P2 after-sales spec), and a unit
  in transfer on its transfer order line, in Inventory (Lifecycle stages); any other scanned Asset is
  refused as not awaiting receipt.
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
  A receipt that cannot take the lock after `LOCK_TRIES` tries is told to scan again (HTTP 503) and
  the unit is
  not received; one without an ASN stays on order, so the rescan finds it by serial.
- Receipts of one unit are made under a job lock on the Asset (`LOCK.receiveAsset`), from a
  fresh read. A scan of a unit another scan is still receiving saves nothing and answers HTTP 503
  *Another scan is receiving this unit: scan again*. The rescan finds it received and answers HTTP 409
  *Not awaiting receipt* (a returned unit is then pending evaluation). The overdue job takes the same
  lock to declare a unit missing (P2 after-sales spec).
- An unknown serial with a PID is created under a job lock on the serial (`LOCK.receiveSerial`),
  re-checked there, so two first scans create one Asset. ASN rows take the same lock (above), so a
  scan and an ASN row of one serial create one Asset too. A scan that finds the lock held is told to
  scan again (HTTP 503), and the rescan finds the Asset by serial.
- A unit for a waiting line is saved, taken off its *On order* count (or its RMA marked received),
  reserved and staged (its Staging task opened and its move into staging saved) under the line's job
  lock (`LOCK.orderLine`, P1 ordering spec). So sourcing's count of the line (allocated, *On
  order*, OEM RMAs whose replacement is still to come) sees all of a receipt or none of it, and so
  does *Cancel order*, which holds the lock of each of its lines while it releases their units: a
  receipt lands wholly before the cancel, or finds the line cancelled. A receipt that cannot take the
  lock after `LONG_HOLD_LOCK_TRIES` tries saves nothing and answers HTTP 503 *Its order line is
  being sourced, received
  or cancelled: scan again*. Under the line's lock the line and its Order are read again. The unit is
  allocated only while the Order is neither cancelled nor rejected and the line is still awaiting
  stock with fewer Assets than its quantity. Otherwise it stays received as free stock (available),
  the line's *On order* count and any OEM RMA are left as they are, and a warning is logged that
  names the unit, the line and the reason (`platform/receiving.ts`); for
  an advance replacement it adds that the RMA is left open, to update by hand. A receipt that
  outlasted the line's lock (ADR 0013) stages no further after it is lost, and logs what it
  did to the unit after the lock was lost, to check that the unit is still on the line.
- **Put-away** records the stockroom an Asset now sits in (for an inventory tech, one of theirs):
  - available stock and returned units awaiting evaluation, wipe or disposal go into any stockroom;
  - a unit being staged (one received for a waiting PO line among them) goes only into a staging
    centre;
  - reserved, spare-pool and staged Assets, and anything not in stock, are refused.

  A put-away the platform refuses to save answers HTTP 422 with its reason. It is made under the
  Asset's stock lock (`LOCK.reserveAsset`, P1 ordering spec), from a fresh read. So a unit a
  sourcing run or the spare-pool top-up claims meanwhile is refused (HTTP 409), and a scan that finds
  the lock held through `LOCK_TRIES` tries saves nothing and answers HTTP 503 *This unit is being
  reserved or
  moved: scan again*.
- **Pick** confirms an Asset is a staged Asset of the given Order.

## Staging

- The checklist is the most specific active template matching the Asset's Customer > manufacturer >
  device class and staging source. Distributor-staged Assets get verification templates.
- A Staging task is kept only with every step of its template. If the platform refuses a step, the task
  and its steps are removed (a task that cannot be deleted is named in a warning, to cancel) and the
  Asset stays reserved for its line.
- Steps stamp who and when. A task can be closed complete only when closing can move its Asset to
  the stage it sends it to (staged, or pending evaluation when its result is *failed*), the task
  still stands for the Asset, and, unless it failed, all mandatory steps are done. Otherwise the
  closure is refused and the user is told what to do:
  - a unit still in transfer to the staging centre (its task opened at sourcing, P1 ordering spec):
    *<serial> is still in transfer to the staging centre: close <task> once the staging centre
    receives it*; received there with its task open, it goes into staging (Lifecycle stages, In
    transfer). Closed before, it would be left reserved there with no task;
  - a unit no longer on the task's Order line (released, or sourced for another line): *<serial> is
    no longer on the order line <task> stages for: close <task> skipped*;
  - a unit put back and sourced again under a newer open task: *<serial> has a newer Staging task,
    <newer>: close <task> skipped and stage the unit under <newer>*, so it is never staged against
    the older checklist;
  - a unit in any stage closing cannot move on from (shipped, staged on a failed close, available,
    ...): *<serial> is <stage>, not in staging, so closing <task> cannot move it to <stage>: close
    <task> skipped if it is no longer needed*;
  - an Asset that cannot be read: *The asset of <task> cannot be read: close <task> skipped*.

  A unit in staging, or still reserved for the task's line (its move into staging refused when the
  task opened, which closing makes first), can be closed. So can one already at the stage closing
  sends it to (the task reopened and closed again), which moves nothing more. A failed Asset goes to
  pending evaluation and leaves the line. A move the platform refuses is reported to the user, who
  reopens the task and closes it again. A failed Asset whose move to pending evaluation is refused
  still leaves its line, which is derived and sourced again, and stays in staging until the task is
  closed as failed again. An Asset that changed between the closure check and the move is left as it
  is, and the user is told *<task> is closed but moved nothing (reopen it to close it again): ...*.
- Closing a task *Closed Skipped* or *Closed Incomplete* moves nothing, so it is refused only while
  the unit, on the task's line with that line and its Order still open and no newer task, still
  needs the task: in transfer to the staging centre (*... which needs <task>: close <task> complete
  once the staging centre receives it*) or in staging (*... close <task> complete, or failed to send
  the unit for evaluation*). The app's own skips (a cancel or rejection, a transfer that fell
  through, a move into staging refused at sourcing) pass. The check runs only where the closure
  guard's condition (`br_staging_guard_closure`) takes states 4 and 7 as well as 3.

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
  ships and says so; the Shipment, change (its *Parent*) and work order (its *Initiated from*) name the Order, to link them by hand.
- Ship runs one at a time per Order, under a job lock on it (`LOCK.shipOrder`), and reads the
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
  - the Asset's CI `last_discovered`, read for pending Assets by the detection job (its interval is
    in `in-service/in-service.now.ts`).
- An Asset is in service at the first sighting at or after its install completion. A temporary Order
  gives a temporary deployment instead.
- At that moment:
  - the in-service date is set;
  - the Asset joins its Site's package line, or else the Agreement's line for its device class
    (one for its Site before one with no Site). A line whose end date is before the in-service date
    is passed over, even when it is not set ended, and one already started is chosen before one that
    starts later;
  - a pending line becomes active with its start date under a job lock on the line
    (`LOCK.subscriptionLine`), only while it is still pending when read again there. A line
    another go-live started is joined with its start date kept. One ended meanwhile, or whose lock
    another go-live holds through `LOCK_TRIES` tries, leaves the Asset pending in service (logged),
    and its
    next sighting chooses among the open lines;
  - the lifecycle phase and refresh due date are computed.
- Sightings of one Asset are applied one at a time under a job lock on it (`LOCK.seenAsset`),
  from a fresh read: last_seen only moves forward and only a still-pending Asset goes live. An NMS
  event that finds the lock held `LONG_HOLD_LOCK_TRIES` times, or whose Asset save is refused
  (logged as an error), is
  not applied and is returned in `busy_identifiers`; the detection job leaves that Asset to its next
  run. A go-live whose save is refused after its Subscription line was started leaves the line
  active: the sighting applied again joins it, its start date kept.
- Device events store state changes only. They are purged after `x_daas_ham.events.retention_days`.
