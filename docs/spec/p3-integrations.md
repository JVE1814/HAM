# Shipping aggregator and OEM claims (P3.26–P3.27)

## Shipping aggregator (D73)

- Off by default (`x_daas_ham.shipping.enabled`). The REST message *NaaS Shipping aggregator* calls
  ShipEngine's one-call label API (`POST /v1/labels`) with the key in `x_daas_ham.shipping.api_key`.
- **Outbound**: *Ship* on an Order without a tracking number buys the label instead of asking for
  one: from the depot (`x_daas_ham.staging.default_stockroom`'s location) to the Site, addressed to
  the first site contact, one package per staged Asset (`x_daas_ham.shipping.package_kg` each,
  at most 20), service `x_daas_ham.shipping.service_code`. Nothing is bought when nothing is
  staged; hot spares already at the Site are not shipped. The carrier and tracking number land on
  the Order; a **Shipment** records the label, cost and status. A remote-hands install still needs
  no carrier.
- **Returns**: *Create return label* on a ship-back Return order buys a label from the Site to the
  depot for the awaited Assets. The customer page shows it as *Print return label*.
- Addresses need a name, street, city, postal code and country; a missing part is reported before
  anything is bought. Countries are sent as ISO codes: a location's two-letter code, or a common
  country name translated (an unknown name is reported).
- **Tracking webhook**: `POST /api/x_daas_ham/naas/shipping/tracking?token=…` (no platform login;
  the token must equal `x_daas_ham.shipping.webhook_token`, and nothing is accepted while it is
  empty). ShipEngine (`data.status_code`) and EasyPost (`result.status`) payloads are understood.
  The Shipment's status, latest update and estimated delivery are updated and new tracking events
  added; the first *delivered* update puts a work note on the Order. Late or out-of-order updates
  do not move a delivered (or returned) shipment back; *unknown* never replaces a known status. Unknown tracking numbers are
  acknowledged and ignored.

| Aggregator status | Shipment status |
|---|---|
| ShipEngine AC, NY / EasyPost pre_transit | Label created |
| IT, AT / in_transit | In transit |
| out_for_delivery, available_for_pickup | Out for delivery |
| DE, SP / delivered | Delivered |
| EX / failure, error, cancelled | Exception |
| return_to_sender | Returned to sender |

## OEM claims (D70)

- A staging template step can be **done by the OEM cloud**; its staging steps then start *pending*
  and are ticked automatically when the manufacturer confirms. Steps without automation stay manual,
  as does everything Cisco (PnP has no public API).

| Vendor (model *OEM data source*) | Claim / register | Subscription | Zero-touch |
|---|---|---|---|
| Meraki | `inventory/claim` by serial into the Customer's organization | — | — |
| Mist | org inventory by **claim code** (already claimed counts as done) | — | — |
| Aruba (GreenLake) | add device by serial + **MAC** to the Provider's workspace | find the device, assign the Customer's subscription | — |
| Fortinet | FortiCloud product registration (Provider account) | — | FortiZTP: provision to the Customer's FortiManager |
| Check Point | — | — | Zero Touch: assign to the Customer's template |

- The Customer's account per vendor and purpose (org id, subscription id, FortiManager OID,
  template) is an **OEM cloud account** record. MAC addresses and claim codes come from the ASN
  import (or are entered on the Asset).
- A job every 5 minutes works through pending steps, and failed ones last tried over 30 minutes
  ago, per enabled vendor (`x_daas_ham.oem.claim.<vendor>.enabled`), within
  `x_daas_ham.oem.claim.max_calls` calls per vendor per run (Meraki allows 10 claims per 5 minutes).
- A failure records the reason and counts an attempt; after 5 attempts the step is left for a
  person (*OEM claims to do by hand* in the workspace).
