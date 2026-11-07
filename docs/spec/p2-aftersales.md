# Break-fix, returns, refresh and disposal (P2.2–P2.6)

## Break-fix (D46, D58)

- A CSM case names the **failed asset**. The case takes the Agreement's replacement service level
  and the Asset's Customer.
- **Raise replacement** (NOC, asset manager, CSM agent) creates a *device replace* Order: one line,
  same Model, *replaces asset* = the failed unit. The Order is submitted at once; one that Submit
  refuses (ordering spec) stays a draft, linked to the case, to correct and submit. If the Order or
  its line cannot be saved, nothing is raised (an Order without its line is removed again, or named
  to cancel). If the case cannot be linked, the Order stays a draft that names the case, to link and
  submit.
- **Raise replacement** is offered while the case links no Order, or one that was rejected or
  cancelled: a new Order then takes its place on the case. A form opened before the link can still send
  it: a linked draft is then submitted again, and a linked Order awaiting approval, going ahead or
  complete is kept (`domain/breakfix.ts`).
- Replacement lines skip the entitlement checks: a like-for-like swap is not a new catalog choice and
  adds no usage.
- Sourcing follows the replacement priority: hot spare at the Site (in a customer-site stockroom
  located at the Site or one of its Rooms; one at another Site is not used) → Spare pool → central
  stock.
- If no stock is left:
  - a failed unit with **OEM coverage today** gets an **OEM RMA** record (advance replacement, *to
    open*) instead of a purchase, when the line is for the failed unit's own Model (refresh lines
    and replacements by a different Model are purchased). If the RMA record cannot be saved, a
    warning is logged and the line's sourcing summary says to open it by hand; the line waits for
    stock;
  - the RMA is opened with the vendor manually;
  - the OEM's replacement unit is received with the RMA number in the PO field (ASN or warehouse
    app), allocated to the waiting line, and the RMA becomes *replacement received*.
- SLAs on the case: next business day 24 h, same day 8 h, 24x7x4 4 h (wall clock). They stop when the
  replacement Order completes (in service). A replacement served from a hot spare at the Site reaches
  *installing* at Ship (the spare is handed over as shipped), so its install can then be confirmed or
  its swap work order closed.
- On install completion the failed unit goes on a **defective return**, collected by the swap work
  order.
- **Defective returned to OEM** on the RMA retires the unit as *returned to OEM*. This needs wipe
  evidence recorded since the unit was last received back at the depot (receipt clears earlier
  evidence). When the unit cannot be retired, the user is told why and the RMA is left as it was.

## Returns (D60)

| Trigger | Raised by |
|---|---|
| Site decommission / device removal | Record producer *Return or decommission network equipment*, or the customer page |
| Refresh swap-back, defective return | Install completion of refresh / replacement Orders (collected by the same work order); a Return the platform refuses is logged, the replaced units stay in service, and completing the install again raises it |
| Agreement end | Daily job, once per Agreement after its end date: one Return per Site for all equipment installed or still shipped there, each a field de-install with its own normal change and de-install work order |
| Temporary end | Daily job, `x_daas_ham.returns.temporary_lead_days` before a temporary Order's end date |

- Through the record producer, a return is raised only when the Return create rule lets its requester
  in (asset managers, account managers, NOC, the service desk and Customer admins): a Customer admin
  requests only for their own Customer, the others for any Customer, and site contacts never. The Site
  must be one of the Customer's Sites. Otherwise the request is removed again and the requester is
  told why (`domain/returns.ts` `returnRequestFindings`). The Site choices follow the chosen Customer.
- Installed and shipped Assets on a return become *pending return*. The due date is the Agreement's
  return allowance.
- An Asset already awaiting another return is not added again; completing an install twice raises
  one return. A return with nothing to bring back closes at once (a temporary Order still being
  installed waits until its equipment is installed or its end date passes).
- A site decommission returns everything installed at the Site (in service, temporary, pending in
  service), whatever devices the request lists. From the record producer it also returns units still
  shipped to the Site (`domain/returns.ts` `SITE_RECOVERY_STAGES`), so none is left holding the site
  package open; a decommission from the customer page leaves them.
- Devices chosen for a device removal must be at the chosen Site; others are ignored.
- Field de-install opens a normal change and a de-install work order. Ship-back relies on the Site
  contact.
- **Receipt** at the depot (warehouse app, Receive), for units pending return (or missing), only into a
  central depot or a staging centre, never a customer-site stockroom:
  - the unit goes to *pending evaluation* and leaves its Site, Rack position and subscription line;
    its wipe evidence is cleared (a wipe recorded before it went out does not cover what it picked
    up at the Site), so it must be wiped again before it leaves the Provider;
  - the active site package of the Site and Agreement the unit leaves ends that day once nothing is
    left there under that Agreement (shipped, pending in service, in service, temporary or pending
    return). Units received or declared missing no longer count. A swap's new units count before
    monitoring first sees them, so a swap-back that reaches the depot first leaves the package open,
    and a new unit that leaves before it was seen still ends it. All units count, not only those the
    receiving tech can see. A pending package waiting for its rollout is not ended
    (`domain/returns.ts` `sitePackageHoldersQuery`);
  - a unit received after the due date incurs a **late-return fee**;
  - a unit declared missing that turns up settles its line again: the open lost-asset fee is
    waived, the late-return fee applies, and the Return order reopens for evaluation.

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
    without a second fee.
- Fees use the Agreement's lost / late / damage amounts. A zero amount records nothing. Each fee type
  is charged at most once per Asset and Return order (a waived fee aside), so a step retried after a
  refused save never charges twice. A fee the platform refuses is logged.

## Refresh (D48)

- Daily, fully automatic. It covers in-service Assets with a refresh due date within
  `x_daas_ham.refresh.horizon_days` that are not already on an open replacing line, grouped per
  Agreement and Site.
- **Successor model**: the same Model while it is a current catalog entry and not past end of sale.
  Otherwise, the catalogued Model of the same device class with the latest end of support.
- Waves where some Asset has no successor stay **draft** with a work note for review. All others are
  submitted (within the agreement) and fulfilled like any Order; one that Submit refuses stays a draft
  with the reasons in its work notes.
- An Order or line the platform refuses is logged; its Assets, on no open replacing line, are raised
  again on the next run.
- Shipping opens a **normal** change for the Customer's approval inside the maintenance window.

## Disposal (D61)

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
- **Complete disposal** retires each line whose Asset is pending wipe or disposal, has wipe evidence
  recorded since it was last received back at the depot or last entered staging (both clear earlier
  evidence), uses a method allowed for its legal owner and, when customer-owned, belongs to the
  order's Customer (an order with no Customer returns no customer-owned Asset):

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
