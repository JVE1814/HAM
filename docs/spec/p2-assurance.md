# Audits, attestation, reconciliation, racks and customer self-service (P2.7–P2.9)

## Audits (Q63)

- **Start blind count** is offered only on NaaS stockrooms, those with a stockroom type: one with
  none is the Provider IT's (ADR 0016). Pressed on a form opened before its type was cleared, it is
  refused with *Blind count not started: this is not a NaaS stockroom (it has no stockroom type)*.
- A blind count lists as expected every fleet asset on the stockroom's shelves: *In stock* by
  install status and available, reserved, spare pool, staging, staged, pending evaluation, pending
  wipe, pending disposal or in transfer. A unit on a transfer order line stays on the shelf of the
  stockroom it leaves until the line is In Transit: Inventory keeps it *In stock / Pending transfer*
  and sets the stockroom it goes to only once the line is received (ADR 0002). At In Transit it is
  *In transit*, on no shelf, and is not expected. The Provider IT's equipment in the stockroom is
  not expected either, so a scan of it is marked unexpected.
- **Start site audit** on a Site lists its installed fleet assets (pending in service, in service,
  temporary deployment) and dispatches a site-audit work order under a standard change.
- An Asset whose audit line the platform refuses is left out of the expected count (logged), and the
  user is told how many. An expected count or work order the platform refuses to save on a started
  audit is logged and the user told; the audit stands.
- Technicians scan in the warehouse app's **Audit** mode. Scans are blind: no unit details are
  shown. A scan the platform refuses to record answers HTTP 422 with a generic message (why is
  logged), to scan again.
- An inventory tech sees, scans and closes only the blind counts of their Stockrooms; site audits
  are for field techs. Field techs and asset managers scan and close any open audit; other staff
  (NOC, account managers, finance) only read audits. An audit the user may not see answers *No open
  audit with that number*.
- **Close audit**:
  - the audit is closed first: one the platform refuses to close stays open (the user is told why),
    with no line marked and no exception raised. A line result refused after the close, or a
    *missing in audit* exception that is not open afterwards (read back, so a refused insert
    counts), is logged and counted to the user, to fix by hand;
  - a scan names the expected Asset whose serial it is, else whose Provider tag, else whose Customer
    tag (case-insensitive), as everywhere a code is resolved; a code two expected Assets carry in
    the same field names neither and is marked unexpected, for a person to resolve;
  - unmatched expected Assets become *missing in audit* exceptions;
  - scans matching nothing are marked unexpected;
  - counts are stored.

## Attestation

- Daily, for each active Agreement with an attestation interval, each Site with installed Assets gets
  an attestation when:
  - none is open (a pending one counts); and
  - the last one was attested more than the interval ago (or never).
- A Site has one attestation at a time, listing every Asset installed there, whichever Agreement it
  is under. A Site served by several attesting Agreements follows the shortest of their intervals, and
  the attestation records the Agreement whose interval raised it.
- It is assigned to a Customer admin.
- Customer admins answer each device (present / not present / don't know) on the customer page and
  submit once all are answered. *Not present* answers become *customer reports missing* exceptions.
- An attestation is raised pending and opened only once every installed Asset is listed on it. One
  the platform refuses is logged, and one whose item or opening it refuses is removed (logged): either
  is raised again on the next run. One the platform will not remove stays pending, is logged to
  cancel, and cannot be submitted, pending or once cancelled (HTTP 422). An answer the platform
  refuses answers HTTP 422 without submitting, and a refused submit answers HTTP 422 and leaves the
  attestation open. Either can be sent again, which raises no exception twice (exceptions open once
  per type and Asset).

## Reconciliation (daily)

Each installed Asset is checked for:
- **unseen**: no Seen signal for `x_daas_ham.reconciliation.unseen_days`, or never seen;
- **serial mismatch** with its CI;
- **site mismatch** with its CI's location: the CI's location, or the location two levels up
  (room → building → site), must be the Asset's Site.

Exceptions open once per type and Asset (or CI; a rack's overlap and power exceptions once per
rack), also when two runs raise the same one at once: the check and the insert are made under a lock
on the type and subject. They resolve themselves when the condition clears. One the platform refuses
is logged (an audit or attestation, closed once, does not raise it again).
Network-gear CIs discovered recently with no Asset raise *seen without asset*. Racks with an open
rack exception are re-checked as well (see Racks), and their rack exceptions open or resolve.

## Racks (Q67)

- Placement is the lowest rack unit plus the face; the height comes from the Model's rack units
  (minimum 1).
- Saving a placement that leaves the rack or overlaps another device on the same face is refused.
- Adding a racked Asset to the fleet (*Add to fleet*) is checked as placing it, as a device new to
  the rack: one that does not fit, or would take the rack over its power budget, is refused with
  the reason and stays outside the fleet (ADR 0016).
- **Power budget (plan §13 Rack power budget)**: a rack with a *power capacity (W)* also refuses a placement that would
  take the typical power (the Models' *typical power (W)*) of all devices in it, both faces, over
  the capacity, when the change adds draw (a device new to the rack, or a different Model). Moves
  within the rack are always allowed. The elevation page shows used against available power.
- The checks read the placements already saved, so two saves into the same units of one rack at the
  same moment can both pass (the check is a before rule, and a lock taken there ends before the
  record is written). Once a save that changes an Asset's rack, lowest unit, face or Model, or adds
  a racked Asset to the fleet, is written, an after rule re-checks the rack it is in and the rack it
  left. The re-check reads every fleet asset placed there afresh, past the visibility rules. It
  opens *Devices overlap in rack* when devices share units on one face, and *Rack over power
  budget* when their typical power (both faces) is over the rack's capacity. One of each is open
  per rack, naming the devices (by asset tag, else serial) or the watts. Each resolves when a later
  re-check finds it cleared. The daily reconciliation also re-checks every rack with one open, so
  one cleared by a Model's size or power, the rack's capacity or a deleted Asset resolves too.
- The checks count every fleet asset placed in the rack, including ones the saving user cannot see
  (an inventory tech sees only their Stockrooms' Assets); the Provider IT's equipment in it is not
  counted (ADR 0016). The elevation page and its power figure still show only what the viewer may
  see.
- The **rack elevation** page (`x_daas_ham_racks.do`) shows the front and rear of the racks in a
  Site's rooms. A device links to its Asset form for provider staff only (the six NaaS staff roles,
  and administrators); Customer contacts, external users the platform UI does not open for, see its
  tag and Model as plain text. Colours are by stage, customer, or risk:
  - *high*: past end of support, or no current coverage;
  - *medium*: end of sale, or refresh due within 180 days.
- The page and its endpoints show Customer contacts only the racks at Sites they can see (their
  Customer's; a Site contact's own Sites of their Customer). Other Sites and racks answer *not
  found*. Staff see every Site. A rack is shown only at a Site or in a Room of one (a location whose
  parent is the Site): a rack at any other location, such as the Provider IT's data-centre room or a
  room under a building of the Site, is not listed and answers *not found*, to staff too.

## Customer self-service (Q49)

The page `x_daas_ham_customer.do` is for Customer admins and Site contacts; link it from the CSM
portal menu. Asset managers can open it as a preview (navigator *Customer self-service (preview)*):
they see every Customer and take only the *Everyone* actions. Returns and attestations are for
Customer admins limited to their own Customer (`domain/visibility.ts` `actsAsCustomerAdmin`); staff
raise returns through the *Return or decommission network equipment* record producer, and the API
refuses anyone else with HTTP 403, and a return request for a location that is not one of the
Customer's Sites with HTTP 400. Visibility rules limit everything to the user's Customer (Site
contacts: their Sites).

| Who | Can |
|---|---|
| Everyone | see installed equipment by Site; report a faulty device (CSM case with the failed asset); see open orders and returns; confirm self-installed orders, including the units already shipped of an Order back in preparing after a unit was lost in transit |
| Customer admins | request returns of selected devices or a site decommission; answer attestations |

The equipment listed is the Customer's fleet assets (ADR 0016; `domain/visibility.ts`
`customerEquipmentQuery`), from shipped to a Site to awaiting return, grouped by Site; one with no
Site (a data gap) is listed under *No site*, and one that has lost its Agreement (another) is listed
all the same. The Provider IT's hardware, such as laptops in use, is outside the fleet and is not
listed, in the staff preview either: the Fleet flag tells it apart, where the Agreement only stood in
for it. The query carries the reader's Customer (site contacts: and Sites) in each stage's clause, as a
before-query rule's filter reaches only the last clause of a query with `^NQ` (ADR 0005). A fault is
reported, and a return requested, for fleet assets only: another device answers HTTP 404 *Unknown
device* on `POST /customer/faults`, and is left out of the devices a return request lists.

The page calls the app's REST API under `/api/x_daas_ham/naas`. Its routes, and the rack page's
(`/sites`, `/racks`), do not require the `snc_internal` role, which customer users (`snc_external`)
lack. They admit a user who passes either the platform's *Scripted REST External Default* ACL
(internal users) or the app's REST ACL for customer admins and site contacts
(`security/rest-acls.now.ts`), and each handler checks the role and the Customer. A call the
platform refuses answers
HTTP 422, so it can be sent again:

- `POST /customer/faults` when the case is refused;
- `POST /customer/returns` when the Return order is refused, or no device could be added to it (each
  is already on a return, or was refused);
- `POST /customer/orders/{id}/installed` when a device is not moved to pending in service;
- `POST /customer/attestations/{id}` when an answer or the submission is refused, or the attestation
  is still pending or was cancelled, without submitting.

New equipment is ordered through the *Request network equipment* catalog item.

On the Order form too, Customer contacts can use *Confirm installed* only on self-install Orders; asset
managers and field techs confirm any Order being installed (for instance when its work order was closed
elsewhere). An Order is being installed when it is installing, or held back in preparing or
delivering by a line not shipped yet: confirming it then installs only the units already shipped.
