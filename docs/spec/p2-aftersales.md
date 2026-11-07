# Break-fix, returns, refresh and disposal (P2.2–P2.6)

## Break-fix (D46, D58)

- A CSM case names the **failed asset**. The case takes the Agreement's replacement service level
  and the Asset's Customer.
- **Raise replacement** (NOC, asset manager, CSM agent) creates a *device replace* Order: one line,
  same Model, *replaces asset* = the failed unit. The Order is submitted at once; one that Submit
  refuses (ordering spec) stays a draft, linked to the case, to correct and submit.
- **Raise replacement** is offered while the case links no Order, or one that was rejected or
  cancelled: a new Order then takes its place on the case. A form opened before the link can still send
  it: a linked draft is then submitted again, and a linked Order awaiting approval, going ahead or
  complete is kept (`domain/breakfix.ts`).
- Replacement lines skip the entitlement checks: a like-for-like swap is not a new catalog choice and
  adds no usage.
- Sourcing follows the replacement priority: hot spare at the Site → Spare pool → central stock.
- If no stock is left:
  - a failed unit with **OEM coverage today** gets an **OEM RMA** record (advance replacement, *to
    open*) instead of a purchase, when the line is for the failed unit's own Model (refresh lines
    and replacements by a different Model are purchased);
  - the RMA is opened with the vendor manually;
  - the OEM's replacement unit is received with the RMA number in the PO field (ASN or warehouse
    app), allocated to the waiting line, and the RMA becomes *replacement received*.
- SLAs on the case: next business day 24 h, same day 8 h, 24x7x4 4 h (wall clock). They stop when the
  replacement Order completes (in service).
- On install completion the failed unit goes on a **defective return**, collected by the swap work
  order.
- **Defective returned to OEM** on the RMA retires the unit as *returned to OEM*. This needs wipe
  evidence.

## Returns (D60)

| Trigger | Raised by |
|---|---|
| Site decommission / device removal | Record producer *Return or decommission network equipment*, or the customer page |
| Refresh swap-back, defective return | Install completion of refresh / replacement Orders (collected by the same work order) |
| Agreement end | Daily job, once per Agreement after its end date (all installed equipment) |
| Temporary end | Daily job, `x_daas_ham.returns.temporary_lead_days` before a temporary Order's end date |

- Through the record producer, a return is raised only when the Return create rule lets its requester
  in (asset managers, account managers, NOC, the service desk and Customer admins): a Customer admin
  requests only for their own Customer, the others for any Customer, and site contacts never. The Site
  must be one of the Customer's Sites. Otherwise the request is removed again and the requester is
  told why (`domain/returns.ts` `returnRequestFindings`). The Site choices follow the chosen Customer.
- Installed Assets on a return become *pending return*. The due date is the Agreement's return
  allowance.
- An Asset already awaiting another return is not added again; completing an install twice raises
  one return. A return with nothing to bring back closes at once (a temporary Order still being
  installed waits until its equipment is installed or its end date passes).
- A site decommission, from the record producer or the customer page, returns everything installed at
  the Site (in service, temporary, pending in service), whatever devices the request lists.
- Devices chosen for a device removal must be at the chosen Site; others are ignored.
- Field de-install opens a normal change and a de-install work order. Ship-back relies on the Site
  contact.
- **Receipt** at the depot (warehouse app, Receive), for units pending return (or missing), only into a
  central depot or a staging centre, never a customer-site stockroom:
  - the unit goes to *pending evaluation* and leaves its Site, Rack position and subscription line;
  - a site package with no Assets left ends that day (all its units count, not only those the
    receiving tech can see);
  - a unit received after the due date incurs a **late-return fee**;
  - a unit declared missing that turns up settles its line again: the open lost-asset fee is
    waived, the late-return fee applies, and the Return order reopens for evaluation.
- **Evaluation** on the return line:

  | Choice | Result |
  |---|---|
  | refurbish | available, back under the Provider company; customer-owned units go to wiping instead |
  | OEM RMA | pending OEM RMA |
  | scrap, return to owner | pending wipe |

  A *damaged* condition incurs a damage fee. The Return order closes when every line is evaluated
  or missing.
- **Overdue** (daily):
  - the first day after the due date, the return is escalated once per Return order and the
    Customer admins and account manager are emailed;
  - after `x_daas_ham.returns.grace_days`, the Asset is declared *missing* (its Rack position is
    freed) and a lost-asset fee is recorded.
- Fees use the Agreement's lost / late / damage amounts. A zero amount records nothing.

## Refresh (D48)

- Daily, fully automatic. It covers in-service Assets with a refresh due date within
  `x_daas_ham.refresh.horizon_days` that are not already on an open replacing line, grouped per
  Agreement and Site.
- **Successor model**: the same Model while it is a current catalog entry and not past end of sale.
  Otherwise, the catalogued Model of the same device class with the latest end of support.
- Waves where some Asset has no successor stay **draft** with a work note for review. All others are
  submitted (within the agreement) and fulfilled like any Order; one that Submit refuses stays a draft
  with the reasons in its work notes.
- Shipping opens a **normal** change for the Customer's approval inside the maintenance window.

## Disposal (D61)

- A **Disposal order** has a method, lines and optional per-line method overrides.
  - **Submit for approval** asks the provider-side approvers (asset managers), plus Customer admins
    when any Asset is customer-owned.
  - Rejection closes it.
- **Complete disposal** retires each line whose Asset is pending wipe or disposal, has wipe evidence,
  and uses a method allowed for its legal owner:

  | Legal owner | Allowed methods |
  |---|---|
  | Provider | resale (*sold*), OEM takeback (*returned to OEM*), ITAD (*disposed*) |
  | Customer | return to customer |
  | Lessor | return to lessor |

  Other lines are marked blocked with the reasons, and the order stays approved until they are
  cleared.
