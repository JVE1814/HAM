# Audits, attestation, reconciliation, racks and customer self-service (P2.7–P2.9)

## Audits (D63)

- **Start blind count** on a stockroom lists everything in stock there as expected.
- **Start site audit** on a Site lists its installed Assets and dispatches a site-audit work order
  under a standard change.
- Technicians scan in the warehouse app's **Audit** mode. Scans are blind: no unit details are shown.
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
- It is assigned to a Customer admin.
- Customer admins answer each device (present / not present / don't know) on the customer page and
  submit once all are answered. *Not present* answers become *customer reports missing* exceptions.

## Reconciliation (daily)

Each installed Asset is checked for:
- **unseen**: no Seen signal for `x_daas_ham.reconciliation.unseen_days`, or never seen;
- **serial mismatch** with its CI;
- **site mismatch** with its CI's location (or that location's parent).

Exceptions open once per type and Asset, and resolve themselves when the condition clears.
Network-gear CIs discovered recently with no Asset raise *seen without asset*.

## Racks (D67)

- Placement is the lowest rack unit plus the face; the height comes from the Model's rack units
  (minimum 1).
- Saving a placement that leaves the rack or overlaps another device on the same face is refused.
- The **rack elevation** page (`x_daas_ham_racks.do`) shows the front and rear of the racks in a
  Site's rooms. Colours are by stage, customer, or risk:
  - *high*: past end of support, or no current coverage;
  - *medium*: end of sale, or refresh due within 180 days.

## Customer self-service (D49)

The page `x_daas_ham_customer.do` is for Customer admins and Site contacts; link it from the CSM
portal menu. Visibility rules limit everything to the user's Customer (Site contacts: their Sites).

| Who | Can |
|---|---|
| Everyone | see installed equipment by Site; report a faulty device (CSM case with the failed asset); see open orders and returns; confirm self-installed orders |
| Customer admins | request returns of selected devices or a site decommission; answer attestations |

New equipment is ordered through the *Request network equipment* catalog item.
