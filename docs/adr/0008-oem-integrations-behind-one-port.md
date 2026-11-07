# OEM integrations sit behind one port per capability

Lifecycle (EoX), coverage and RMA-status data come from Cisco, Meraki, Fortinet and HPE Mist APIs;
claim/provisioning from Meraki, HPE GreenLake, FortiZTP, Mist and Check Point. Each capability is one
port in the domain with one adapter per vendor, mapping vendor JSON to our DTOs; vendors without an API
fall back to CSV import into the same tables. No vendor offers an API to *create* an RMA, so OEM RMAs
are opened manually and only their status is synced (Cisco).

The transport behind every port is one `HttpPort` (`domain/http.ts`): a named function of a REST
message plus an optional JSON body. The shipping aggregator (P3) uses the same seam, so its label and
tracking mapping is tested with fakes like the OEM adapters.

Claim and provisioning calls run in a five-minute job with a per-vendor call budget (Meraki allows 10
claim calls per 5 minutes), so a run loads only as many staging steps as its budget can send; the
Customer's account in each vendor cloud is a configuration record, not code.
