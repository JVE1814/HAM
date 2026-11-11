# OEM integrations sit behind one port per capability

Lifecycle (EoX), coverage and RMA-status data come from Cisco, Meraki, Fortinet and HPE Mist APIs;
claim/provisioning from Meraki, HPE GreenLake, FortiZTP, Mist and Check Point. Each capability is one
port in the domain with one adapter per vendor, mapping vendor JSON to our DTOs; vendors without an API
fall back to CSV import into the same tables. No vendor offers an API to *create* an RMA, so OEM RMAs
are opened manually and only their status is synced (Cisco).

The transport behind every port is one `HttpPort` (`domain/http.ts`): a named function of a REST
message plus an optional JSON body. The shipping aggregator (P3) uses the same seam, so its label and
tracking mapping is tested with fakes like the OEM adapters. A call that gets no answer
(RESTMessageV2's status 0 for a timeout or a DNS, TLS or connection failure, or a thrown error) comes
back as status 0 with the transport's reason in `HttpResponse.error`, logged by the transport;
`failureText` reads it as *no response: <reason>*.

Claim and provisioning calls run in a frequent job with a per-vendor call budget (Meraki allows 10
claim calls per 5 minutes; the job's interval is in `oem/logic.now.ts` and the budget is the property
`PROPERTY.claimMaxCalls` of `domain/properties.ts`, which go together), so a run loads only as many
staging steps as its budget can send; the
Customer's account in each vendor cloud is a configuration record, not code.
