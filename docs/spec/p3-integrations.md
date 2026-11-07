# Shipping aggregator and OEM claims (P3.26–P3.27)

## Shipping aggregator (D73)

- Off by default (`x_daas_ham.shipping.enabled`). The REST message *NaaS Shipping aggregator* calls
  ShipEngine's one-call label API (`POST /v1/labels`) with the key in `x_daas_ham.shipping.api_key`,
  billed to the carrier account `x_daas_ham.shipping.carrier_id` (no label is bought while it is
  empty).
- **Outbound**: *Ship* on an Order without a tracking number buys the label instead of asking for
  one: from the depot (`x_daas_ham.staging.default_stockroom`'s location) to the Site, addressed to
  the first site contact, one package per staged Asset (`x_daas_ham.shipping.package_kg` each,
  at most 20), service `x_daas_ham.shipping.service_code`. Nothing is bought when nothing is
  staged; hot spares already at the Site are not shipped. The carrier and tracking number land on
  the Order; a **Shipment** records the label, cost and status. A remote-hands install still needs
  no carrier.
- **Returns**: *Create return label* on a ship-back Return order buys a label from the Site to the
  depot for the awaited Assets. The customer page shows it as *Print return label*.
- Addresses need a name, street, city, postal code and country (U.S. and Canadian states as their
  two-letter codes), and the sender a phone number (ShipEngine requires `ship_from.phone`): the
  location's phone, else `x_daas_ham.shipping.sender_phone` for the depot or the first site
  contact's phone for a Site. A missing part is reported before anything is bought, and empty
  optional parts are left out of the request. Countries are sent as ISO codes: a location's two-letter code, or a common
  country name translated (an unknown name is reported).
- **Tracking webhook**: `POST /api/x_daas_ham/naas/shipping/tracking` (no platform login). The token
  comes in the custom header `X-NaaS-Webhook-Token` (configure it on the ShipEngine webhook's
  `headers` or EasyPost's `custom_headers`), else in `?token=`; it must equal
  `x_daas_ham.shipping.webhook_token`, and nothing is accepted while that is empty. ShipEngine
  (`data.status_code`) and EasyPost tracker (`result.object = Tracker`, `result.status`) payloads are
  understood; other EasyPost events are refused, and the latest EasyPost tracking detail is the one
  with the latest `datetime`.
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
| Meraki | `inventory/claim` by serial into the Customer's organization; only serials in the returned `serials` count as claimed (a response without the field counts all) | — | — |
| Mist | org inventory by **claim code** (already claimed counts as done; codes compared without dashes; a 400 with per-code results is read like a 200) | — | — |
| Aruba (GreenLake) | add device by serial + **MAC** to the Provider's workspace, at most 5 per call (`network`, with `compute` and `storage` empty) | find the device, assign the Customer's subscription (merge-patch JSON); a device already carrying it counts as done | — |
| Fortinet | FortiCloud product registration (Provider account) | — | FortiZTP: provision to the Customer's FortiManager |
| Check Point | — | — | Zero Touch web API v2: `login`, `claim-gateway` (serial as object name, account id, template id, MAC), `logout`; login and logout count as calls |

- The Customer's account per vendor and purpose is an **OEM cloud account** record: Meraki
  organization id, Mist org id, GreenLake subscription id (the subscription's UUID, not its key),
  FortiManager OID, and for Check Point `<User Center account id>/<template id>` (both numbers,
  e.g. `1234567/42`; template ids come from Zero Touch `show-all-templates`). MAC addresses and claim
  codes come from the ASN import (or are entered on the Asset).
- Credentials: Meraki and Mist keys in `x_daas_ham.meraki.api_key` and `x_daas_ham.mist.api_token`;
  Check Point in `x_daas_ham.checkpoint.api_client_id` and `x_daas_ham.checkpoint.api_key` (generated
  in the Zero Touch portal, valid 1-180 days); GreenLake and FortiZTP through an OAuth 2.0 profile on
  the REST message.
- API hosts: Meraki and Mist calls go to `x_daas_ham.meraki.api_host` (default `api.meraki.com`;
  `api.meraki.ca`, `.cn`, `.in` or `api.gov-meraki.com` for other dashboards) and
  `x_daas_ham.mist.api_host` (default `api.mist.com`; the portal host with `manage` replaced by
  `api`). All Mist orgs must be on that one cloud. Whether RESTMessageV2 substitutes a variable in the
  host part is still to be confirmed on an instance (fallback: set the endpoint in code).
- A job every 5 minutes works through pending steps, and failed ones last tried over 30 minutes
  ago, per enabled vendor (`x_daas_ham.oem.claim.<vendor>.enabled`), within
  `x_daas_ham.oem.claim.max_calls` calls per vendor per run (Meraki allows 10 claims per 5 minutes).
- A failure records the reason and counts an attempt; after 5 attempts the step is left for a
  person (*OEM claims to do by hand* in the workspace). Licence and zero-touch steps start as
  *Waiting for the OEM claim step* when their staging task also has a claim step: they are not
  sent and use no attempts, also while the claim step is left for a person, and go to pending as
  soon as the claim step is ticked done, by hand or by a run.
- *Ship* and *Create return label* refuse more than 20 packages (one label's maximum): enter the
  carrier and tracking number by hand. A Return order gets one open return label at a time.
