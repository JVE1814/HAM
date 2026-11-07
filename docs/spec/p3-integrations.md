# Shipping aggregator and OEM claim adapters (P3.26–P3.27)

## Shipping aggregator (D73)

- Off by default (`x_daas_ham.shipping.enabled`). The REST message *NaaS Shipping aggregator* calls
  ShipEngine's one-call label API (`POST /v1/labels`) with the key in `x_daas_ham.shipping.api_key`.
- **Outbound**: *Ship* on an Order without a tracking number buys the label instead of asking for
  one: from the depot (`x_daas_ham.staging.default_stockroom`'s location) to the Site, addressed to
  the first site contact, one package per staged Asset (`x_daas_ham.shipping.package_kg` each,
  at most 20), service `x_daas_ham.shipping.service_code`. The carrier and tracking number land on
  the Order; a **Shipment** records the label, cost and status. A remote-hands install still needs
  no carrier.
- **Returns**: *Create return label* on a ship-back Return order buys a label from the Site to the
  depot for the awaited Assets. The customer page shows it as *Print return label*.
- Addresses need a name, street, city, postal code and country; a missing part is reported before
  anything is bought.
- **Tracking webhook**: `POST /api/x_daas_ham/naas/shipping/tracking?token=…` (no platform login;
  the token must equal `x_daas_ham.shipping.webhook_token`, and nothing is accepted while it is
  empty). ShipEngine (`data.status_code`) and EasyPost (`result.status`) payloads are understood.
  The Shipment's status, latest update and estimated delivery are updated and new tracking events
  added; the first *delivered* update puts a work note on the Order. Unknown tracking numbers are
  acknowledged and ignored.

| Aggregator status | Shipment status |
|---|---|
| ShipEngine AC, NY / EasyPost pre_transit | Label created |
| IT, AT / in_transit | In transit |
| out_for_delivery, available_for_pickup | Out for delivery |
| DE, SP / delivered | Delivered |
| EX / failure, error, cancelled | Exception |
| return_to_sender | Returned to sender |
