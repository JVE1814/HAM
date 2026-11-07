# Audits, attestation, reconciliation, racks and customer self-service (P2.7–P2.9)

## Audits (D63)

- **Start blind count** on a stockroom lists everything in stock there as expected.
- **Start site audit** on a Site lists its installed Assets and dispatches a site-audit work order
  under a standard change.
- Technicians scan in the warehouse app's **Audit** mode. Scans are blind: no unit details are shown.
- An inventory tech sees, scans and closes only the blind counts of their Stockrooms; site audits are
  for field techs. Other staff work on any open audit. An audit the user may not see answers *No open
  audit with that number*.
- **Close audit**:
  - scans are matched to expected Assets by serial, provider tag or customer tag (case-insensitive);
  - unmatched expected Assets become *missing in audit* exceptions;
  - scans matching nothing are marked unexpected;
  - counts are stored.

## Attestation

- Daily, for each active Agreement with an attestation interval, each Site with installed Assets gets
  an attestation when:
  - none is open; and
  - the last one was attested more than the interval ago (or never).
- A Site has one attestation at a time, listing every Asset installed there, whichever Agreement it
  is under. A Site served by several attesting Agreements follows the shortest of their intervals, and
  the attestation records the Agreement whose interval raised it.
- It is assigned to a Customer admin.
- Customer admins answer each device (present / not present / don't know) on the customer page and
  submit once all are answered. *Not present* answers become *customer reports missing* exceptions.

## Reconciliation (daily)

Each installed Asset is checked for:
- **unseen**: no Seen signal for `x_daas_ham.reconciliation.unseen_days`, or never seen;
- **serial mismatch** with its CI;
- **site mismatch** with its CI's location: the CI's location, or the location two levels up
  (room → building → site), must be the Asset's Site.

Exceptions open once per type and Asset, and resolve themselves when the condition clears.
Network-gear CIs discovered recently with no Asset raise *seen without asset*.

## Racks (D67)

- Placement is the lowest rack unit plus the face; the height comes from the Model's rack units
  (minimum 1).
- Saving a placement that leaves the rack or overlaps another device on the same face is refused.
- **Power budget (P3.29)**: a rack with a *power capacity (W)* also refuses a placement that would
  take the typical power (the Models' *typical power (W)*) of all devices in it, both faces, over
  the capacity, when the change adds draw (a device new to the rack, or a different Model). Moves
  within the rack are always allowed. The elevation page shows used against available power.
- The **rack elevation** page (`x_daas_ham_racks.do`) shows the front and rear of the racks in a
  Site's rooms. Colours are by stage, customer, or risk:
  - *high*: past end of support, or no current coverage;
  - *medium*: end of sale, or refresh due within 180 days.
- The page and its endpoints show Customer contacts only the racks at Sites they can see (their
  Customer's; a Site contact's own Sites). Other Sites and racks answer *not found*. Staff see every
  Site.

## Customer self-service (D49)

The page `x_daas_ham_customer.do` is for Customer admins and Site contacts; link it from the CSM
portal menu. Visibility rules limit everything to the user's Customer (Site contacts: their Sites).

| Who | Can |
|---|---|
| Everyone | see installed equipment by Site; report a faulty device (CSM case with the failed asset); see open orders and returns; confirm self-installed orders |
| Customer admins | request returns of selected devices or a site decommission; answer attestations |

New equipment is ordered through the *Request network equipment* catalog item.

On the Order form too, Customer contacts can use *Confirm installed* only on self-install Orders; asset
managers and field techs confirm any Order being installed (for instance when its work order was closed
elsewhere).
