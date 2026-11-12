# Break-fix, returns, refresh and disposal (P2.2–P2.6)

All of these act on fleet assets only (ADR 0016). The Provider IT's equipment shares the asset table and
is never replaced, returned, refreshed, declared missing, charged for or disposed of here.

## Break-fix (Q46, Q58)

- A CSM case names the **failed asset**, a fleet asset (the field offers fleet assets only). The case
  takes the Agreement's replacement service level and, when it names no account yet, the Asset's
  Customer as its account. A failed asset outside the fleet, set past the field's qualifier by a
  script, gives the case neither, and **Raise replacement** refuses it (*Only a fleet asset is
  replaced*). A failed asset of another Customer than the case's account gives the case nothing
  either and leaves its account as it is, and **Raise replacement** refuses it (*The failed asset is
  not the case account's*): the Order is raised for the Asset's Customer, at its Site
  (`domain/breakfix.ts` `isAnotherCustomers`).
- **Raise replacement** (NOC, asset manager, CSM agent) creates a *device replace* Order: one line,
  same Model, *replaces asset* = the failed unit. The Order is submitted at once; one that Submit
  refuses (ordering spec) stays a draft, linked to the case, to correct and submit. If the Order or
  its line cannot be saved, nothing is raised (an Order without its line is removed again, or named
  to cancel). If the case cannot be linked, the Order stays a draft that names the case, to link and
  submit. A case form whose save is refused raises nothing (the platform says why).
- **Raise replacement** is offered while the case links no Order, or one that was rejected or
  cancelled: a new Order then takes its place on the case. A form opened before the link can still send
  it: a linked draft is then submitted again, and a linked Order awaiting approval, going ahead or
  complete is kept (`domain/breakfix.ts`).
  Two presses at once take turns under a job lock on the case (`LOCK.replacementCase` in
  `domain/lock-names.ts`, ADR 0013): one that finds it held raises nothing and says *A replacement
  is being raised for this case*, and each press reads the Order the case links afresh under the
  lock, so a press that follows another keeps the Order that one linked.
- Replacement lines skip the entitlement checks: a like-for-like swap is not a new catalog choice and
  adds no usage.
- Sourcing follows the replacement priority: hot spare at the Site (in a customer-site stockroom
  located at the Site or one of its Rooms; one at another Site is not used) → Spare pool → central
  stock.
- If no stock is left:
  - a failed unit with **OEM coverage today** gets an **OEM RMA** record (advance replacement, *to
    open*), or reuses the one already open for that unit (see the lost-in-transit bullet below),
    instead of a purchase, when the line is for the failed unit's own Model (refresh lines and
    replacements by a different Model are purchased). If the RMA record cannot be saved, a warning
    is logged and the line's sourcing summary says to open it by hand; the line waits for stock;
  - the RMA is opened with the vendor manually;
  - the OEM's replacement unit is received with the RMA number in the PO field (ASN or warehouse
    app), allocated to the waiting line, and the RMA becomes *replacement received*.
- SLAs on the case: next business day 24 h, same day 8 h, 24x7x4 4 h (wall clock). They stop when the
  replacement Order completes (in service). Completing the Order queues the event
  `x_daas_ham.replacement.complete` on it (`platform/fulfilment.ts` `recomputeOrder`). Its script
  action saves the case with a work note (*Replacement order <number> is complete: the replacement
  is installed.*), because the SLA engine weighs a case's SLAs only when the case is saved. The
  script action runs as system, outside any interactive session. So Customer Service's case query
  rules, which apply in the interactive sessions of users without case_admin, cannot hide the case
  from it, whoever completed the Order: an asset manager on the Asset form, a customer contact
  confirming the install, or the device-events API. Only an open case that still links that Order,
  now complete, is saved. A refused save, or a case not found, is logged, so the case can be saved
  by hand. A replacement served from a hot spare at the Site reaches
  *installing* at Ship (the spare is handed over as shipped), so its install can then be confirmed or
  its swap work order closed. A hot spare that Ship refused stays in the spare pool: neither
  *Confirm installed* nor closing the swap work order installs it until a later Ship hands it over.
- On install completion the failed unit goes on a **defective return** once its replacement is
  installed, collected by the swap work order.
- A replacement lost in transit (or failed in staging) is sourced again by the usual routes (P1
  fulfilment spec). When that would open an OEM RMA, the RMA already open for the same defective
  unit (*to open*, *open* or *replacement received*) is reused instead (`domain/oem-rma.ts`
  `advanceReplacementRma`): it is put under the line, one whose replacement was received goes back
  to *open*, and the line waits for its replacement. The line's own RMA comes first, then one whose
  replacement is still to come; one another open line waits for is left to it. The sourcing summary
  names it (*RMA <number> already open for <serial>*, adding *its replacement was received, ask the
  vendor for another* when it was reopened). If the platform refuses the reuse, a warning is logged
  and the summary says to do it by hand; no second RMA is opened.
- **Defective returned to OEM** on the RMA retires the unit as *returned to OEM*; a defective asset
  outside the fleet is refused and left as it is. This needs wipe
  evidence recorded since the unit was last received back at the depot (receipt clears earlier
  evidence). When the unit cannot be retired, the user is told why and the RMA is left as it was.
  When the unit is retired but the RMA's save is refused, the user is told the serial and why, and
  presses the action again once that is fixed: only the RMA is marked then.

## Returns (Q60)

| Trigger | Raised by |
|---|---|
| Site decommission / device removal | Record producer *Return or decommission network equipment*, or the customer page |
| Refresh swap-back, defective return | Install completion of refresh / replacement Orders, for each replaced unit whose own replacement is installed (collected by the same work order); a Return the platform refuses is logged, the replaced units stay in service, and completing the install again raises it |
| Agreement end | Daily job, once per Agreement after its end date: one Return per Site for all equipment installed or still shipped there, each a field de-install with its own normal change and de-install work order; each Site's Return is raised once per end, so a run whose mark on the Agreement is refused (logged) raises nothing twice and saves the mark again |
| Temporary end | Daily job, `x_daas_ham.returns.temporary_lead_days` before a temporary Order's end date; raised once per Order, and a refused mark is logged and saved again on the next run |

- The daily job reads at most 50 ended Agreements and 50 ending temporary Orders a run, each in
  sys_id order from where the last run stopped, and starts over after the last (ADR 0007). One it
  leaves for a later run (a Return or its mark refused, an Order still being installed) does not
  keep those after it from being read. A run that reads a full page and leaves every record of it
  logs a warning.
- Through the record producer, a return is raised only when the Return create rule lets its requester
  in (asset managers, account managers, NOC, the service desk and Customer admins): a Customer admin
  requests only for their own Customer, the others for any Customer, and site contacts never. The Site
  must be one of the Customer's Sites. Otherwise the request is removed again (one the platform keeps
  is logged, to cancel) and the requester is told why (`domain/returns.ts` `returnRequestFindings`).
  Its answers to the producer's questions stay on the instance: the platform's `question_answer`
  table lets no application delete from it. The Site choices follow the chosen Customer.
- A Return order saved in a Customer contact's session is checked before it is saved, whatever
  inserts it: it must name the contact's own Customer and one of that Customer's Sites, else it is
  refused with *Return not raised* and the reason (`platform/returns.ts`
  `contactReturnInsertRefusal`). A contact's insert by hand (a form, the Table API) keeps no posted
  value, as they are an external user, so it names no Customer and is refused; the Site check
  guards the record producer, the customer page and any other insert that keeps the values. The
  swap-back Return that a site contact's install confirmation raises passes: it is for the Order's
  Customer and Site.
- From the customer page, only a Customer admin limited to their own Customer requests returns
  (`domain/visibility.ts` `actsAsCustomerAdmin`), under the record producer's rule
  (`domain/returns.ts` `returnRequestFindings`). The API answers HTTP 403 when the Return create rule
  leaves the caller out, and HTTP 400 when the Site is not one of their Customer's Sites. The Return
  is raised for the caller's own Customer. Provider staff and platform admins get HTTP 403 there and
  use the record producer.
- A Customer's requests from the customer page are raised one at a time, under the job lock
  `LOCK.returnRequest` in `domain/lock-names.ts` (ADR 0013), and only for devices not already
  awaiting a return.
  A request that finds the lock held answers HTTP 503 and raises nothing. A request whose devices all
  await a return already answers HTTP 409. So a request sent twice raises one Return order (and, for
  a field de-install, one de-install work order and one change). The page sends one action at a
  time, offers no device pending return for another return, and clears the selection once a Return
  is raised. Every Return, whoever raises it, puts each unit on it under `LOCK.returnAsset` and
  checks under that lock that the unit awaits no other return, so a unit is on one
  awaiting line at a time. A unit whose lock is held through `LOCK_TRIES` tries
  (`domain/job-lock.ts`) is left off. If it then still
  awaits no return (the holder was slow, refused or died holding the lock), it counts as refused and
  a warning says to put it on a return by hand if it is due back.
- Only fleet assets go on a Return: one of the Provider IT's that a request or a job lists is left off,
  logged as a warning (`platform/returns.ts`), and a Return left with no unit closes at
  once. The units a site decommission, an agreement end or a temporary end returns are the fleet assets
  there.
- Installed and shipped Assets on a return become *pending return*. The due date is the Agreement's
  return allowance. A unit still shipped that goes on a device removal, or is declared missing while
  still shipped, leaves its Order line, which is filled again (P1 fulfilment spec). On a site
  decommission, agreement end or temporary end it stays on its line, which is not sourced again.
- An Asset already awaiting another return is not added again; completing an install twice raises
  one return. A return with nothing to bring back closes at once (a temporary Order still being
  installed waits until all its equipment is installed or its end date passes; once the end date
  has passed, its units still shipped come back too).
- A site decommission returns everything installed at the Site (in service, temporary, pending in
  service), whatever devices the request lists. From the record producer and the customer page it
  also returns units still shipped to the Site (`domain/returns.ts` `stagesTakenBack`), so none
  is left holding the site package open. A requested decommission returns the units its requester
  may see: the read carries their visibility filter in each stage's clause (`platform/visibility`
  `visibleQuery`, ADR 0005). A Customer admin's decommission therefore leaves a unit at the Site
  whose company is another Customer's, or blank (a data gap), off the Return. Staff see every
  Customer and return everything at the Site.
- Devices chosen for a device removal must be fleet assets deployed at the chosen Site (shipped,
  pending in service, in service, temporary or pending return); others are ignored, so a unit
  declared missing, which keeps its Site, is never charged a second lost-asset fee.
- Field de-install opens a normal change and a de-install work order. Ship-back relies on the Site
  contact.
- **Receipt** at the depot (warehouse app, Receive), for units pending return (or missing), only into a
  central depot or a staging centre, never a customer-site stockroom:
  - the unit goes to *pending evaluation* and leaves its Site, Rack position and subscription line;
    its wipe evidence is cleared (a wipe recorded before it went out does not cover what it picked
    up at the Site), so it must be wiped again before it leaves the Provider;
  - the active site package of the Site and Agreement the unit leaves ends that day once no fleet
    asset is left there under that Agreement (shipped, pending in service, in service, temporary or
    pending return). Units received or declared missing no longer count. A swap's new units count before
    monitoring first sees them, so a swap-back that reaches the depot first leaves the package open,
    and a new unit that leaves before it was seen still ends it. All units count, not only those the
    receiving tech can see. A pending package waiting for its rollout is not ended
    (`domain/billing.ts` `sitePackageHoldersQuery`);
  - a unit received after the due date incurs a **late-return fee**;
  - a unit declared missing that turns up settles its line again: the open lost-asset fee is
    waived, the late-return fee applies, and the Return order reopens for evaluation. A fee on a
    Billing period that is closed, or that is being closed or regenerated just then, is not waived:
    it stays open and is logged as an error, to settle by hand (P3 billing, ADR 0013).

  A receipt the lifecycle or the platform refuses answers HTTP 422 with the reason and leaves the unit
  pending return (or missing), with nothing settled, to scan again. If the unit is saved but its
  return line is not (or its Return order is not reopened, or its site package not ended), this is
  logged, to fix by hand.
- **Evaluation** on the return line:

  | Choice | Result |
  |---|---|
  | refurbish | available, back under the Provider company; customer-owned units, and lessor-owned units of a lease being returned, go to wiping instead (`domain/returns.ts` `evaluationTarget`) |
  | OEM RMA | pending OEM RMA |
  | scrap, return to owner | pending wipe |

  A *damaged* condition incurs a damage fee. The Return order closes when every line is evaluated
  or missing. If the Asset's move is refused, the user is told and the line stays received, so the
  evaluation can be chosen again.
- **Overdue** (daily):
  - the first day after the due date, the return is escalated once per Return order and, once the
    escalation is saved, the Customer admins and account manager are emailed;
  - after `x_daas_ham.returns.grace_days`, the Asset is declared *missing* (its Rack position is
    freed) and a lost-asset fee is recorded. The active site package of its Site and Agreement ends
    that day once nothing else is left there, as on receipt. The missing unit keeps its Site and
    subscription line so that, found again and back in service, it bills on that line again while
    the line is open;
  - a unit whose move to missing is refused stays pending return with its line awaiting, and the
    next run declares it again: the lost-asset fee and the site package's end follow only a saved
    move. A line that cannot be saved as missing is logged and declared again on the next run,
    without a second fee;
  - the declaration takes the unit's receive lock (`LOCK.receiveAsset`), the same one a depot
    scan takes (P1 fulfilment spec), and works from a fresh read. It goes ahead only while the line
    still awaits the unit and the unit is still at or on its way to the Site, pending return or
    already missing. A run that finds a scan receiving the unit leaves the line awaiting for the next
    day's run, so a unit scanned in that day is never also declared missing or charged a lost-asset
    fee;
  - a line whose unit is neither at nor on its way to the Site nor missing (for example received at
    the depot while its line could not be saved), is in a stage the lifecycle does not move to
    missing, or is not a fleet asset (a line raised before the Fleet flag), is not declared missing,
    and no move is tried. It is logged on each run, to settle by hand.
  - after the chase, the same run closes each open Return order, created more than a day ago, that
    no line keeps open (`platform/returns.ts` `closeDoneReturns`): one with no line at all
    (inserted by hand, or raised with no unit when its close or its removal was refused), and one
    whose lines are all evaluated or missing but whose close was refused then. It gets a work
    note, and the close is logged. One created within the last day is left, as its lines may still
    be added by hand. A close the platform refuses is logged as a warning and tried again by the
    next run. The pass keeps a job cursor of its own (`close_done_returns`, ADR 0007).
- Fees use the Agreement's lost / late / damage amounts. A zero amount records nothing. Each fee type
  is charged at most once per Asset and Return order (a waived fee aside), so a step retried after a
  refused save never charges twice. Two steps charging the same fee at once (two users saving one
  return line's evaluation) check for and record it under a job lock on the fee (ADR 0013), so it is
  charged once. One that finds the lock held `LOCK_TRIES` times leaves the fee to the other and logs
  a warning if
  it is still not recorded. Two scans of one unit, and overlapping overdue runs, already take turns
  under the unit's receive lock. A fee the platform refuses is logged.

## Refresh (Q48)

- Daily, fully automatic. It covers in-service fleet assets of an Agreement with a refresh due date
  within `x_daas_ham.refresh.horizon_days` that are not already on an open replacing line, grouped
  per Agreement and Site. A run raises a capped number (`CANDIDATES_PER_RUN` in
  `platform/refresh.ts`), earliest due first, and Assets already on an
  open replacing line take none of those places (ADR 0007).
- **Successor model**: the same Model while it is a current catalog entry and not past end of sale.
  Otherwise, the catalogued Model of the same device class with the latest end of support. A Model
  whose end of support is not known (not synced from its OEM yet, or with no date) ranks after every
  Model with one, in catalog order.
- Waves where some Asset has no successor stay **draft** with a work note for review. All others are
  submitted (within the agreement) and fulfilled like any Order; one that Submit refuses stays a draft
  with the reasons in its work notes.
- An Order or line the platform refuses is logged; its Assets, on no open replacing line, are raised
  again on the next run. An Order none of whose lines is saved is removed again, and the removal is
  logged, so refused saves leave no empty drafts behind. One the platform will not remove is logged
  by number, to cancel.
- A run holds the job lock `LOCK.refreshOrders` (ADR 0013) from its read of the open replacing lines
  to
  its last Order. A run that finds it held, such as the scheduled job and an *Execute now* at once,
  raises nothing and logs so. A run that outlasts the lock stops after the wave it lost it in and
  logs an error naming that Order, to check its Assets are on no other open Order.
- Shipping opens a **normal** change for the Customer's approval inside the maintenance window.

## Disposal (Q61)

- A **Disposal order** has a method, lines and optional per-line method overrides.
  - **Submit for approval** asks the provider-side approvers (asset managers), plus the order's
    Customer's admins when any Asset is customer-owned. That Customer must be set, and every
    customer-owned Asset must belong to it (its company): otherwise Submit says why, naming the
    Assets that do not belong, and the order stays a draft. Submit asks no one when the form save is
    refused, and cancels its requests again if the order cannot be saved as awaiting approval.
  - Rejection closes it. If the approved or rejected outcome cannot be saved, the order stays
    awaiting approval with its requests (logged), and the next decision on them tries again.
  - Once the order leaves draft, what it retires is fixed: lines cannot be added, removed or pointed
    at another order, Asset or method, and the order's method and Customer cannot change (before
    rules on the line and the order). Complete disposal still records each line's status and
    blockers. An administrator may still remove a line from a submitted order (removing retires
    nothing), so an order whose line can never be retired can still be completed, and deleting an
    order takes its lines with it.
- **Complete disposal** retires each line whose Asset is a fleet asset, is pending wipe or disposal,
  has wipe evidence recorded since it was last received back at the depot or last entered staging
  (both clear earlier evidence), uses a method allowed for its legal owner and, when customer-owned,
  belongs to the order's Customer (an order with no Customer returns no customer-owned Asset):

  | Legal owner | Allowed methods |
  |---|---|
  | Provider | resale (*sold*), OEM takeback (*returned to OEM*), ITAD (*disposed*) |
  | Customer | return to customer |
  | Lessor | return to lessor |

  A pending-wipe Asset is saved as pending disposal first, then retired. A line is done only when
  the retiring save is kept. A line whose Asset is not found or is outside the user's Stockrooms (ADR
  0005) is blocked like any other. Lines that are not retired are marked blocked with the reasons,
  and the order stays approved until they are cleared. It also stays open while any line cannot be
  saved: one refused after its Asset was retired is logged as *done, its asset retired* and must be
  set done by hand, since completing again would mark it blocked (its Asset is no longer awaiting
  disposal).
