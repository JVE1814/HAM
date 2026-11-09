# Shipping aggregator and OEM claims (P3.26–P3.27)

## Shipping aggregator (D73)

- Off by default (`x_daas_ham.shipping.enabled`). The REST message *NaaS Shipping aggregator* calls
  ShipEngine's one-call label API (`POST /v1/labels`) with the key in `x_daas_ham.shipping.api_key`,
  billed to the carrier account `x_daas_ham.shipping.carrier_id` (no label is bought while it is
  empty).
- **Outbound**: *Ship* on an Order without a tracking number entered by hand buys the label instead
  of asking for one: from the depot (`x_daas_ham.staging.default_stockroom`'s location) to the Site,
  addressed to the first site contact, one package per staged Asset (`x_daas_ham.shipping.package_kg`
  each, at most 20), service `x_daas_ham.shipping.service_code`. Nothing is bought when nothing is
  staged; hot spares already at the Site are handed over without a package. The carrier and tracking
  number land on the Order until the label is marked voided (below); a **Shipment** records the
  label, cost and status. A remote-hands install still needs no carrier. Ship runs one at a time per
  Order (P1 fulfilment spec), so two presses buy one label.
- The number of a label an earlier Ship bought does not count as entered by hand: a later Ship, for
  Assets staged since, buys them a label of their own, or asks for a tracking number while the
  aggregator is off. With a tracking number entered by hand, no label is bought.
- **Returns**: *Create return label* on a ship-back Return order buys a label from the Site to the
  depot for the awaited Assets. The customer page shows it as *Print return label*.
- *Create return label* refuses while the Return order has an open return label. While that label is
  *Label created* or *Exception*, it says to void it with the carrier and use *Mark label voided*.
  While it is *In transit* or *Out for delivery*, it says the return is already under way and names
  its tracking number, since *Mark label voided* is not offered then.
- Two presses of *Create return label* at once buy one label. The check and the purchase are made
  under a job lock on the Return order (`return_label_<sys_id>`), and a press that finds a label being
  bought is told so and buys nothing.
- A return label voided with the carrier is closed with *Mark label voided* on its Shipment (asset
  managers, inventory techs and the NOC, while it is *Label created* or *Exception*). Nothing is sent
  to the aggregator. The Shipment becomes *Voided*, which is final, and the Return order gets a work
  note (if the save is refused, the Shipment stays open and the Return order gets no note). The
  check and the save are made under the Shipment's tracking lock, from the Shipment read again
  there, so a tracking update saved at the same moment cannot put a voided label back to
  *Exception*; while the lock stays held it says to try again and changes nothing. The
  customer page stops offering the label and a new return label can be created. Voided Shipments,
  like delivered and returned ones, are left out of the workspace list *Shipments under way*.
- An outbound label (Ship's) is closed the same way, by the same roles and in the same statuses: the
  Shipment becomes *Voided* (final) under its tracking lock. Its Order is cleared when the Order's
  tracking number is the label's and its carrier is the label's (ignoring case) or empty: the
  tracking number and carrier are emptied, and the Order gets a work note naming the voided label
  and saying to buy the replacement with the carrier and type its carrier and tracking number on the
  Order. An Order tracking another label (a later Ship's, one typed since, or the same number with a
  different carrier) is left as it is. No unit is un-shipped and nothing is bought.
- The void and the Order's clearing run under the Order's Ship lock (`ship_order_<sys_id>`), so a
  Ship buying a new label meanwhile cannot have its number cleared. A void pressed while a Ship or a
  *Cancel order* of the Order, or another void of its labels, is running changes nothing and says to
  try again once it has finished. If the Order's save is refused, the label stays voided and the
  user is told to clear the tracking number and carrier by hand.
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
  do not move a delivered, returned or voided shipment back; *unknown* never replaces a known status.
  Unknown tracking numbers are acknowledged and ignored.
  Each update is applied under the job lock `track_shipment_<Shipment sys_id>`, from the Shipment and
  its events read again there. So overlapping deliveries of the same history store each event once
  and note the delivery once, and an older status cannot replace a delivery.
  A delivery that finds the lock held 5 times in a row is retried inside the app, not by the
  aggregator: ShipEngine waits 10 seconds for a 2xx, then makes at most two more attempts, typically
  30 minutes apart, and drops the update (EasyPost up to 6). The delivery is answered HTTP 202
  `{"matched": true, "queued": true}` at once, and the update (status, detail, estimated delivery,
  delivery time, the time of its newest event and the events not stored yet) is queued as the event
  `x_daas_ham.shipment.track` on the Shipment, in its `parm1` (at most 4000 characters, the event
  parameter's size; events that do not fit one are shared out over several events, each a whole
  update). Its script action applies it as the webhook would, under the same lock. Updates applied
  while it waited may be newer: when an event stored meanwhile happened after its newest, only its
  events are added, so its older status, latest update and estimate cannot move the Shipment back
  (say from *Out for delivery* to *In transit*); a delivery or return is still taken, as it would
  have stayed had the updates come in order. While the lock is still held, or the Shipment or an
  event is refused, the script action queues it again about a minute later, at most 15 times (past
  the lock's ten-minute abandonment), then drops it with a warning naming the Shipment and its
  tracking number. Only an update that cannot be queued (one tracking event too long for a
  parameter by itself) is answered HTTP 503 *Another update of this Shipment is being saved; send
  it again*.
  If the platform refuses the Shipment or a tracking event, the refusal is logged and the reply is
  500, not 2xx. An aggregator that retries failed deliveries then sends the update again; the retry
  skips events already stored and does not repeat the delivered note.

| Aggregator status | Shipment status |
|---|---|
| ShipEngine AC, NY / EasyPost pre_transit | Label created |
| IT, AT / in_transit | In transit |
| out_for_delivery, available_for_pickup | Out for delivery |
| DE, SP / delivered | Delivered |
| EX / failure, error, cancelled | Exception |
| return_to_sender | Returned to sender |
| — (set by *Mark label voided* on a return or outbound label, never by tracking) | Voided |

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
  soon as the claim step is ticked done, by hand or by a run. A step whose save is refused is logged
  and stays due, so it is sent again.
- *Ship* and *Create return label* refuse more than 20 packages (one label's maximum): enter the
  carrier and tracking number by hand. A Return order gets one open return label at a time;
  delivered, returned and voided labels are not open, so to replace a label still *Label created* or
  *Exception*, void it with the carrier and mark it voided; one *In transit* or *Out for delivery* is
  the return under way, and *Create return label* says so and names its tracking number.
