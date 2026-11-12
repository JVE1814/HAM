# One shipping aggregator, webhooks authenticated by a shared token

Labels are bought through one aggregator REST message in ShipEngine's one-call label shape rather than
an adapter per carrier; switching aggregator means changing that message and the request mapping in
domain/shipping.ts, while tracking webhooks are read in both ShipEngine and EasyPost shapes. The
webhook endpoint has no platform login because aggregators cannot send ServiceNow credentials; it is
authenticated by a shared token that both ShipEngine (webhook `headers`) and EasyPost
(`custom_headers`) can send as the custom header `X-NaaS-Webhook-Token`, with a URL query
(`?token=`) as the fallback (undocumented by both vendors). The token is compared in constant time
and everything is refused while the token property is empty. Manual tracking numbers
remain possible when the aggregator is off.
