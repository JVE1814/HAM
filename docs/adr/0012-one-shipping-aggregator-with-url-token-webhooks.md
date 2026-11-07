# One shipping aggregator, webhooks authenticated by a URL token

Labels are bought through one aggregator REST message in ShipEngine's one-call label shape rather than
an adapter per carrier; switching aggregator means changing that message and the request mapping in
domain/shipping.ts, while tracking webhooks are read in both ShipEngine and EasyPost shapes. The
webhook endpoint has no platform login because aggregators cannot send ServiceNow credentials or
custom headers; it is authenticated by a shared token in the URL query (`?token=`), compared in
constant time and refusing everything while the token property is empty. Manual tracking numbers
remain possible when the aggregator is off.
