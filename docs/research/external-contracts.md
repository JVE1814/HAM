# External contracts checked against primary sources

**Scope.** This note records which external API contracts and ServiceNow platform fields the NaaS
HAM app (scope `x_daas_ham`) relies on, and whether each one was checked against a primary source.
It covers the Cisco Support APIs, Meraki Dashboard, HPE Mist, HPE GreenLake, FortiCloud and
FortiZTP, Check Point Zero Touch, ShipEngine, EasyPost and the ServiceNow platform. Research date:
2026-11-07; every web source was accessed that day. Verdicts rest on primary sources only: vendor API
references, OpenAPI specs and official SDKs published by the vendor, ServiceNow product
documentation, and the official ServiceNow SDK packages in `node_modules` (`@servicenow/sdk-core`,
`sdk-build-plugins` and `sdk-build-core` 4.14.0; `@servicenow/glide` 27.0.5). Where the primary
reference needs a login, a vendor knowledge-base article or a third-party SDK is cited and labelled
as such, and the item is marked accordingly. No repository file other than this note was changed.
Line numbers refer to the repository as it stood on the research date.

Verdicts: **matches** (the app agrees with the source), **partially** (the core contract agrees,
but a limit, edge case or secondary field does not), **differs** (the app contradicts the source),
**unverifiable** (no reachable primary source settles it).

Short file names used below:

| Short name | Path |
|---|---|
| `adapters.ts`, `adapters.test.ts` | `src/server/domain/oem/` |
| `claims.ts`, `claims.test.ts` | `src/server/domain/oem/` |
| `oem-messages.now.ts`, `oem-claims.now.ts`, `shipping.now.ts`, `rest.now.ts`, `rules.now.ts` | `src/fluent/logic/` |
| `oem.now.ts`, `staging.now.ts`, `substatus-choices.now.ts` | `src/fluent/data/` |
| `oem-sync.ts`, `entry/oem-claims.ts`, `entry/shipping.ts`, `margin.ts`, `leases.ts`, `billing.ts`, `delivery.ts`, `in-service.ts`, `assurance.ts`, `warehouse.ts`, `spare-pool.ts`, `demo-seed.ts` | `src/server/entry/` |
| `rest-port.ts`, `properties.ts`, `procurement.ts`, `field-work.ts`, `assets.ts`, `rest-api.ts` | `src/server/platform/` |
| `http.ts`, `json.ts`, `domain/shipping.ts`, `shipping.test.ts`, `lifecycle.ts`, `model-lifecycle.ts`, `substatus-choices.test.ts` | `src/server/domain/` |
| `keys.ts` | `src/fluent/generated/` |


**Status (2026-11-07):** every change under "Changes needed in the app" has been applied, except the
optional EoX pagination and SN2INFO `EXCEEDED_OUTPUT` handling (a batch that always errors would block
the queue) and the speculative FortiZTP v2 / FortiCloud `accountId` changes, which wait for an FNDN
check. What still needs an instance or a vendor login is listed in the README.

## Cisco Support APIs

| Item | App assumes | Source says | Verdict | Source |
|---|---|---|---|---|
| EoX v5 by PID: host, method, path, encoding | `GET https://apix.cisco.com/supporttools/eox/rest/5/EOXByProductID/1/${pids}?responseencoding=json`, PIDs comma-joined (`oem-messages.now.ts:16,22-25`) | URI `.../EOXByProductID/{pageIndex}/{productID}`; sample request has the same form | matches | C1 |
| EoX batching | 20 PIDs per call, page 1 only (`adapters.ts:35`) | 20 PIDs max, but `productID` is limited to 250 characters; 50 records per page | partially | C1 |
| EoX response mapping | `EOXRecord`, skip on `EOXError`, `EOLProductID`, `EndOfSaleDate.value`, `LastDateOfSupport.value` for support and life, `LinkToProductBulletinURL` (`adapters.ts:37-49`) | All fields exist; dates are `{value, dateFormat}`; LDoS definition supports support = life | matches | C1 |
| SN2INFO v2 coverage summary: path and doc status | `GET https://apix.cisco.com/sn2info/v2/coverage/summary/serial_numbers/${serials}` (`oem-messages.now.ts:27-31`) | Same path; the DevNet reference page now returns 404 | matches | C2, C3, C4, C5 |
| SN2INFO batch size | 50 serials per call, page 1 only (`adapters.ts:59`) | Up to 75 serials (40 characters each); 50 records per page | matches | C2, C6 |
| SN2INFO v2 summary response fields | `coverage_start_date`, `coverage_end_date` then `warranty_end_date` (`adapters.ts:61-70`) | v2 summary has no `coverage_start_date` or `coverage_end_date`; contract end is `covered_product_line_end_date` | differs | C2, C6 |
| SN2INFO errors on HTTP 200 | Only non-2xx and non-JSON count as errors (`adapters.ts:19-28,60-61`) | `NO_RECORDS_FOUND` and `EXCEEDED_OUTPUT` arrive with HTTP 200; body shape undocumented | partially | C2 |
| Service Order Return (RMA) v1.0 by RMA number | `GET https://apix.cisco.com/return/v1.0/returns/rma_numbers/${rma}`; reads `returns.RmaRecord[]` (`oem-messages.now.ts:33-37`, `adapters.ts:80-85`) | Same path; one RMA per call; `status` is open, booked, hold, cancelled or closed | matches | C7 |
| OAuth 2.0 client credentials | `oauth2` with a profile attached on the instance (id.cisco.com); no `oauthProfile` in code | Token from `https://id.cisco.com/oauth2/default/v1/token`, client credentials grant, 1-hour tokens | matches | C8, C9, C5, C10, C11 |
| SNTC/PSS entitlement | Required (`oem-messages.now.ts:17`, `docs/spec/p2-oem.md:22`) | APIs are available only to SNTC customers and PSS partners | matches | C12, C9, C2 |
| Rate limits and quotas | No throttling in the Cisco adapters | No numeric limit published; quotas visible only in the API Console | unverifiable | C9, C1, C7 |
| Meraki coverage via SN2INFO | Meraki serials go to SN2INFO (`adapters.ts:195,210`) | SN2INFO reference does not mention Meraki | unverifiable | C2 |

Notes:

- **EoX path.** `pageIndex` is optional (integer, length 5, "a maximum of 50 records per page are
  returned"). `productID` is required (string, length 250, "Enter up to 20 PIDs separated by
  commas"). Wildcards are allowed with at least 3 characters. `responseencoding` is optional, `xml`
  or `json`. The sample request is exactly
  `GET https://apix.cisco.com/supporttools/eox/rest/5/EOXByProductID/1/WIC-1T=?responseencoding=json`.
  `rest-port.ts:27` URL-encodes each value and puts the commas back.
- **EoX batching.** The 20-PID limit is confirmed by error `SSA_ERR_009` ("The number of product IDs
  exceeds 20."). The app does not enforce the 250-character limit: twenty typical PIDs such as
  `WS-C3850-48P-L` (14 characters) plus commas come to about 299 characters.
  `PaginationResponseRecord` (`PageIndex`, `LastIndex`, `TotalRecords`, `PageRecords`) is never read.
  "You can receive multiple EoX records for the same PID if that product includes multiple migration
  paths", so 20 PIDs can exceed one page. `docs/spec/p2-oem.md:7` says "EoX v5 by PID, 20 per call".
- **EoX response.** Top-level keys are `PaginationResponseRecord` and `EOXRecord`. The method sample
  shows `EOXRecord` as an array and the `EOXRecordType` sample as a single object; `asArray` handles
  both. `EOXRecordType` contains `EOLProductID` (string 48), `LinkToProductBulletinURL`,
  `EOXExternalAnnouncementDate`, `EndOfSaleDate`, `EndOfSWMaintenanceReleases`,
  `EndOfSecurityVulSupportDate`, `EndOfRoutineFailureAnalysisDate`, `EndOfServiceContractRenewal`,
  `LastDateOfSupport`, `EndOfSvcAttachDate`, `UpdatedTimeStamp`, `EOXError` (`EOXErrorType`),
  `EOXMigrationDetails`, `EOXInputType` and `EOXInputValue`. In JSON every date is an object such as
  `{"value": "2014-12-27", "dateFormat": "YYYY-MM-DD"}`. `EOXErrorType` has `ErrorID`,
  `ErrorDescription`, `ErrorDataType` and `ErrorDataValue`; `SSA_ERR_026` is "EoX information does
  not exist for the following product ID(s)". `LastDateOfSupport` is "Last date to receive service
  and support for the product. After this date, all support services for the product are
  unavailable, and the product becomes obsolete." Records repeated for multiple migration paths are
  identical apart from `EOXMigrationDetails`, so the duplicate facts are harmless.
  `EndOfSWMaintenanceReleases` and the other milestones are not read by the app.
- **SN2INFO path and documentation status.** Cisco's content file gives
  `https://apix.cisco.com/sn2info/v2/coverage/summary/serial_numbers/{sr_no,sr_no,sr_no}` with an
  optional `page_index`, and the sample
  `GET https://apix.cisco.com/sn2info/v2/coverage/summary/serial_numbers/SAL09232Q0Z,32964768,...?page_index=1`.
  The official CiscoDevNet Postman collection and the SN2INFO v2 WADL resource tree both show
  `sn2info/v2/coverage/summary/serial_numbers/{serial_numbers}` on the legacy host `api.cisco.com`.
  On 2026-11-07 the DevNet reference page returns HTTP 404, the "API References" navigation no
  longer lists SN2INFO, and the Introduction portfolio omits it. The API Changelog still lists
  "Serial Number to Information v2.0", and the WADL downloads page still links `SN2INFO_v2.wadl`. No
  retirement notice was found. Check this against a live call before enabling coverage sync.
- **SN2INFO WADL.** The official WADLs at `apiconsole.cisco.com/files/*.wadl` need an API Console
  login (HTTP 403). The WADL resource tree that was read is a third-party copy
  (https://raw.githubusercontent.com/sieteunoseis/mcp-cisco-support/main/api_docs/SN2INFO_v2.wadl),
  used only as corroboration; it agrees with the Cisco content file (75 serials, 50 records per
  page). The Wayback Machine was unreachable through the proxy.
- **SN2INFO batch size.** `sr_no`: "You can enter up to 75 serial numbers (each with a maximum length
  of 40) separated by commas." The response carries `pagination_response_record` (`last_index`,
  `page_index`, `page_records`, `self_link`, `title`, `total_records`). With 50 serials and one
  record per serial, everything fits on page 1. If a serial ever returned more than one record,
  page 2 would be ignored, because the app does not check `last_index`. The v1.0 PDF has the same
  limits. `docs/spec/p2-oem.md:7` says "SN2INFO v2, 50 per call".
- **SN2INFO summary fields.** The v2 summary response parameters are `base_pid`,
  `contract_site_address1`, `contract_site_city`, `contract_site_country`,
  `contract_site_customer_name`, `contract_site_state_province`, `covered_product_line_end_date`
  (date, "End date of the covered product line in the following format: YYYY-MM-DD"), `id`,
  `is_covered` ("YES or NO"), `item_description`, `item_position`, `item_type`, `last_index`,
  `orderable_pid`, `page_index`, `page_records`, `parent_sr_no`, `pillar_code`, `self_link`,
  `service_contract_number` (string 200), `service_line_descr` (e.g. "SMARTnet Premium 24x7x4"),
  `sr_no`, `title`, `total_records`, `warranty_end_date` (YYYY-MM-DD), `warranty_type` and
  `warranty_type_description`. `coverage_end_date` belongs to the v1.0 summary and to the v2
  `coverage/status` and `owner_status` methods; neither version has `coverage_start_date`. Against v2
  the app never reads the contract end date, always falls back to `warranty_end_date`, and
  `startDate` is always undefined. The test fixture at `adapters.test.ts:49` uses `coverage_end_date`.
- **SN2INFO error table.** `200 NO_RECORDS_FOUND` ("No records found."), `200 EXCEEDED_OUTPUT`
  ("Server error; too many results."), `400 API_MISSING_PARAMETERS`, `API_INVALID_INPUT`,
  `EXCEEDED_INPUTS`, `403 API_NOTAUTHORIZED`, `500 API_ERROR_01`. Today a 2xx body without
  `serial_numbers` yields no facts and no errors, and `oem-sync.ts:93-100` then stamps every serial in
  the batch as checked.
- **RMA.** Sample request `GET https://apix.cisco.com/return/v1.0/returns/rma_numbers/84894022` with
  `Authorization: Bearer ...`. `rma_numbers` is required, int, length 10: "Currently, only one RMA
  Number is required and accepted." Response: `{APIPagination{...}, returns{RmaRecord:[{rmaNo,
  status, orderDate, caseId, ..., contractId, serviceLevel, customerRefInfo, shipToInfo, billToInfo,
  replacementParts, returnLines, laborDetails, notes}]}}`. Status casing varies between samples
  ("Booked", "BOOKED", "HOLD"); the app stores the raw string in `x_daas_ham_oem_rma.status`
  (StringColumn, 100 characters; `oem-sync.ts:195`, `oem.now.ts:57`). `rmaNo` is typed string but the
  sample returns a JSON number; `text()` handles numbers. The parameter table calls `returns` an
  "array", but this doc uses "array" loosely for objects and the sample shows an object. "If a space
  is encountered in a mandatory input parameter, Error 403 is thrown." Error codes:
  `API_RMA_FORMAT_ERROR`, `API_DATEFORMAT_ERROR`, `SVO_NO_RECORDS`.
- **RMA, optional hardening (verdict matches).** (1) `adapters.ts:82`: use
  `asArray(field(json, 'returns')).flatMap((r) => asArray(field(r, 'RmaRecord')))` so `returns` as an
  array is tolerated. (2) `adapters.ts:83`: key the fact by the requested number
  (`const rmaNumber = rma`), so the lookup at `oem-sync.ts:194` (`records.get(fact.rmaNumber)`) cannot
  miss when a numeric `rmaNo` serializes differently. (3) `oem-sync.ts:189`: use
  `str(rma, 'rma_number').trim()` as the key, because a space makes Cisco return 403.
- **OAuth.** Cisco: "the application must first make a request to the Cisco Common Identity SSO
  endpoint at https://id.cisco.com/oauth2/default/v1/token". POST, `Content-Type:
  application/x-www-form-urlencoded`, body `grant_type=client_credentials`, `client_id`,
  `client_secret`. Response `{access_token, token_type: "Bearer", expires_in: 3599}`; "the default
  lifetime ... is 3600 seconds (1 hour)". Each request sends `Authorization: Bearer <token>`. Apps
  are registered in the Cisco API Console with "OAuth2.0 Credentials ... Client Credentials (only)";
  the client ID and secret do not expire. The official Postman collection (2020) still uses the older
  `cloudsso.cisco.com/as/token.oauth2` and `api.cisco.com`, so the app's `id.cisco.com` and
  `apix.cisco.com` match the current docs. ServiceNow (Australia, updated 2026-03-12): a third-party
  OAuth provider's Default Grant type includes "Client credentials" ("does not provide refresh
  tokens"), and the instance auto-generates a default OAuth Entity Profile. Fluent SDK 4.14.0
  `RestMessage.d.ts` documents `oauthProfile` as "sys_id of oauth_entity_profile. Required when
  authenticationType is 'oauth2'" (typed optional). The app relies on an admin setting it on the
  instance after install; confirm that a reinstall does not clear an instance-set profile.
- **SNTC/PSS.** "Cisco Support APIs are available only to Cisco Smart Net Total Care (SNTC)
  customers and Cisco Partner Support Service (PSS) partners. Access is gated through a role-based
  process administered via the Cisco Services Access Management tool." A customer's SNTC Delegated
  Administrator grants API access. Partners must include a PSS contract number, and onboarding "can
  take up to 48 hours". An API user must be granted access before registering an app. Data scoping:
  for SN2INFO, "If no connection is found between the user, contract, and device", the summary returns
  only `base_pid_list`, `is_covered`, `orderable_pid_list`, `sr_no` and `warranty_end_date`, so
  contract fields come back empty for devices outside the API user's contracts.
- **Rate limits.** The app sends one lifecycle call per 20 PIDs daily (`adapters.ts:35`), one
  coverage call per 50 serials time-boxed by `x_daas_ham.job.budget_seconds` (`oem-sync.ts:77-79`),
  and one RMA call per open RMA hourly, up to 200 (`oem-sync.ts:186`). No numeric limit appears on the
  EoX, SN2INFO, RMA, authentication or registration pages; the API Console "Keys" view shows "API
  usage and request quota reports" after login.
- **Meraki via SN2INFO.** Meraki serials (`Q2xx-xxxx-xxxx`) fit the 40-character limit, but no primary
  source confirms that Meraki devices are in the SN2INFO install base or contract data.

Sources:

- C1: https://developer.cisco.com/docs/support-apis/eox/ (live page, no version date on the page;
  content file https://pubhub.devnetcloud.com/media/support-apis/docs/eox.html, Last-Modified
  2026-10-28). Sections used: Get EoX by Product ID(s), EOXRecordType, EOXErrorType, Error Codes.
- C2: https://pubhub.devnetcloud.com/media/support-apis/docs/sn2info.html (DevNet content file,
  Last-Modified 2026-10-28). Sections used: Get Coverage Summary by Serial Number(s) response table and
  sample JSON, Error Codes.
- C3: https://developer.cisco.com/docs/support-apis/serial-number-to-information/ (HTTP 404 on
  2026-11-07).
- C4: https://developer.cisco.com/docs/support-apis/cisco-support-apis-wadl-files/ (links
  https://apiconsole.cisco.com/files/SN2INFO_v2.wadl, which needs an API Console login and returns
  403).
- C5: https://github.com/CiscoDevNet/Cisco_Support_API_Postman (official, commit 29914f2,
  2020-08-07; uses the legacy token host).
- C6: https://pubhub.devnetcloud.com/media/support-apis/docs/sn2info-api-reference-v1.0.pdf (v1.0,
  2015-03-25; same limits; its summary did have `coverage_end_date`).
- C7: https://developer.cisco.com/docs/support-apis/service-order-return-rma/ (live page; content
  file Last-Modified 2026-10-28).
- C8: https://developer.cisco.com/docs/support-apis/authentication/
- C9: https://developer.cisco.com/docs/support-apis/application-registration/
- C10: https://www.servicenow.com/docs/r/Mfoa7nhf~aPBbekkZmQkAQ/KnLfoKZUL6ByMN1bfRdong (Use a
  third-party OAuth provider, Australia, updated 2026-03-12).
- C11: `/home/user/HAM/node_modules/@servicenow/sdk-core/dist/rest/RestMessage.d.ts` (sdk-core 4.14.0).
- C12: https://developer.cisco.com/docs/support-apis/user-onboarding-process/

## Meraki Dashboard and HPE Mist

| Item | App assumes | Source says | Verdict | Source |
|---|---|---|---|---|
| Meraki inventory devices: path, `models[]`, `-HW`, paging | `GET https://api.meraki.com/api/v1/organizations/${org_id}/inventory/devices?models[]=${model}`; `-HW` stripped; first page; first device with `eox` (`oem-messages.now.ts:52`, `adapters.ts:94-104`) | Path and `models` array filter match; official SDK sends `models[]`; example `MR34` / sku `MR34-HW`; paging via `Link` header | matches | M1, M2, M3 |
| Meraki EoX field names | `eox.endOfSaleAt`, `eox.endOfSupportAt` (`adapters.ts:109-110`) | `eox {status, endOfSaleAt, endOfSupportAt}`, date-time strings; no `eoxStatus` field | matches | M1, M2 |
| Meraki API key header | `Authorization: Bearer ${api_key}` (`oem-messages.now.ts:53,65`) | v1 supports Bearer; `X-Cisco-Meraki-API-Key` is the v0 header | matches | M4, M5, M1, M6 |
| Meraki claim into inventory | `POST .../inventory/claim` `{"serials":[...]}`, 50 per call; empty response `serials` means all done (`claims.ts:119-126`) | Body and response field names match; response `serials` lists the serials actually claimed; no per-call maximum | partially | M1, M7, M8, M3 |
| Meraki claim rate limit | 10 calls per 5 minutes; budget 8 per 5-minute run (`oem-claims.now.ts:19-26`) | "up to ten times within a single five minute window"; scope and window type not stated | matches | M7, M1, M9, M8 |
| Meraki API base host | `https://api.meraki.com/api/v1` hard-coded (`oem-messages.now.ts:45,52,63`) | Right "in most parts of the world"; Canada, China, India and FedRAMP use other hosts | partially | M5, M10 |
| Mist JSI inventory: path, filters, paging | `GET https://api.mist.com/api/v1/orgs/${org_id}/jsi/inventory?model=` or `?serial=`; page 1 (`oem-messages.now.ts:112,123`) | Same path; `model`, `serial`, `limit` (default 100), `page`; 200 body is a JSON array | matches | H1, H2 |
| Mist JSI lifecycle fields | `eos_time` = end of sale, `eol_time` = end of life (`adapters.ts:164,168`) | `end_of_sale_time` = end of sale; `eos_time` = end of support; no `eol_time` | differs | H1 |
| Mist JSI warranty and contract fields | `warranty_start_time`, `warranty_end_time`, `contract_start_time`, `contract_end_time` (`adapters.ts:181-187`) | None exist; fields are `warranty_start`, `warranty_end`, `contract_start_date`, `contract_end_date` | differs | H1 |
| Mist claim into inventory | `POST .../orgs/${org_id}/inventory`, bare array of codes, 100 per call; non-2xx fails batch; reasons by position (`claims.ts:140-152`) | Body and field names match; a 400 carries the same per-code result; `reason[]` not documented as parallel to `error[]` | partially | H1 |
| Mist auth header | `Authorization: Token ${api_token}` (`oem-messages.now.ts:113,124,136`) | Same format | matches | H1, H3 |
| Mist rate limits | No explicit assumption; claims about 96 calls per hour | 5,000 calls per hour per token | matches | H3, H1, H4 |
| Mist API host | `https://api.mist.com` for every org (`oem-messages.now.ts:105,112,123,134`) | Global 01 only; 11 other regional hosts | differs | H5, H1 |

Notes:

- **Meraki inventory.** `GET /organizations/{organizationId}/inventory/devices` returns a JSON array.
  Query parameters: `perPage` ("Acceptable range is 3 - 1000. Default is 1000."), `startingAfter` and
  `endingBefore` (tokens that should come from the `Link` header), `usedState`, `search`, and the
  arrays `macs`, `networkIds`, `serials`, `models` ("Search for devices in inventory based on
  model."), `orderNumbers`, `tags`, `tagsFilterType`, `productTypes`, `eoxStatuses`. The official
  Python SDK sends array parameters with a `[]` suffix (`params['models[]']`). The spec does not say
  whether `eox` is left out for devices without EoX data; `eox.status` is nullable. Reading only the
  first page is fine for a model lookup (up to 1000 rows by default).
- **Meraki inventory, optional hardening (verdict matches).** In `adapters.ts:104`, replace
  `asArray(json).find((d) => field(d, 'eox'))` with
  `asArray(json).find((d) => field(d, 'eox', 'endOfSaleAt') || field(d, 'eox', 'endOfSupportAt'))`.
  Otherwise an `eox` object with a null status and no dates is recorded as a fact with no dates, and
  the `break` at line 114 stops the search in the remaining orgs. Optionally append `&perPage=3` (the
  documented minimum) at `oem-messages.now.ts:52`.
- **Meraki EoX fields.** `status` is a nullable string with enum `endOfSale`, `endOfSupport`,
  `nearEndOfSupport`. `endOfSaleAt` ("End of sale date for the device product") and `endOfSupportAt`
  are date-time strings. Example: `"eox": {"status":"endOfSale","endOfSaleAt":"2031-07-29T02:00:00Z",
  "endOfSupportAt":"2032-07-29T02:00:00Z"}`. The filter query parameter is `eoxStatuses` (array;
  `endOfSale`, `endOfSupport`, `nearEndOfSupport` or `null`). A separate
  `GET /organizations/{organizationId}/inventory/devices/eox/overview` returns counts only. The test
  fixture (`adapters.test.ts:75`) uses the same shape.
- **Meraki auth.** Authorization page: "Dashboard API v1 supports Bearer Auth using the standard
  Authorization header parameter", example `Authorization: Bearer {API_KEY}`; it calls
  `X-Cisco-Meraki-API-Key` "v0's" header. Getting Started: "requires a bearer token". The v1 OpenAPI
  still lists both schemes (`meraki_api_key` and `bearerAuth`). The official SDK sends
  `'Authorization: Bearer ' + api_key`. The key comes from the password2 property
  `x_daas_ham.meraki.api_key` (`rest-port.ts:15,28`).
- **Meraki claim.** operationId `claimIntoOrganizationInventory`. The request body is optional, with
  `orders` (string[]), `serials` (string[], "The serials of the devices that should be claimed") and
  `licenses` (`[{key (required), mode addDevices or renew}]`). The 200 response has `orders`,
  `serials` ("The serials of the devices claimed") and `licenses`. Error body format is
  `{"errors": ["..."]}`, so `errorText`'s `errors[0]` matches. OAuth scope, if OAuth is used:
  `dashboard:licensing:config:write`. The 50-serial batch size (`MERAKI_CLAIM_BATCH`, `claims.ts:50`)
  is not documented.
- **Meraki rate limits.** The Rate Limit page gives up to 10 requests per second per organization
  (burst of 10 more in the first second; shared by all apps using the org) and up to 100 requests per
  second per source IP; over the limit the API returns 429 with `Retry-After`. The Errors page:
  429 means "Too many requests... We recommend an exponential backoff". The docs do not say whether
  the claim window is per IP, per org or per key, or whether it is fixed or sliding, so the "per IP"
  scope should not be stated. A 429 today fails the batch and uses one of its `MAX_CLAIM_ATTEMPTS = 5`
  (`claims.ts:120-122`).
- **Meraki claim, recommended (not a contract mismatch).** (1) In `claims.ts` `merakiClaim`, and in
  `mistClaim` the same way, add `if (response.status === 429) break` before the `!isSuccess` branch
  (line 120), so the batch is left for the next run instead of using an attempt. (2) Two adjacent
  5-minute runs can fall in one sliding window (8 + 8 > 10). To guarantee the documented limit, cap
  Meraki at 5 per run, e.g. `Math.min(maxCalls, 5)` in `runVendorClaims` when `vendor === 'meraki'`
  (`max_calls` is shared by all vendors), or change `oem-claims.now.ts:23` `value: 8` to `value: 5`.
- **Meraki hosts.** Getting Started: "In most parts of the world" the base URI is
  `https://api.meraki.com/api/v1`. Other dashboards: Canada `https://api.meraki.ca/api/v1`, China
  `https://api.meraki.cn/api/v1`, India `https://api.meraki.in/api/v1`, United States FedRAMP
  `https://api.gov-meraki.com/api/v1`. The SDK `config.py` lists the same constants.
- **Mist JSI inventory.** operationId `listOrgJsiPastPurchases` ("gets all devices purchased from the
  accounts associated with the Org"). `org_id` is a path uuid. `model`: "Filter results by one or more
  device models. Supports comma-separated values" (example `AP43`). Errors: 400
  `{"detail":"no juniper account linked"}`, 401, 403, 404, 429 `{detail}`. A richer
  `GET .../jsi/inventory/search` also exists, with a `sku` filter, comma-separated serials and model,
  and `search_after` paging. The app tries each configured org until one returns items
  (`adapters.ts:152-158`) and sends the raw PID as `model` (`adapters.ts:164`).
- **Mist JSI, operational caveats (verdict matches).** JSI needs a Juniper support account linked to
  the Mist org; otherwise the call returns 400 "no juniper account linked", which shows as
  "HTTP 400" in the errors list. The `model` filter matches the JSI `model` value (e.g.
  `EX2300-24MP`, `AP43`), not the `sku`, so a PID stored as an ordering SKU may not match;
  `/jsi/inventory/search` has a `sku` filter if needed.
- **Mist lifecycle fields.** `js_inventory_item`: `end_of_sale_time` (integer, "End of sale epoch
  timestamp"), `eos_time` (integer, "End of support time"), `end_of_service_time` (integer, "End of
  service epoch timestamp"), `version_eos_time` (software), `eol_psn` (product support notice for the
  end-of-life milestone). `eol_time` has 0 occurrences in the spec. Example: `end_of_sale_time`
  1561507200, `end_of_service_time` 1661507200, `eos_time` 1672012800. The meaning of
  `end_of_service_time` is not defined, and in the example it is earlier than `eos_time`. Today Mist
  lifecycle records the wrong date as end of sale and never records end of support, so
  refresh-by-support (`model-lifecycle.ts` uses `endOfSupport`) gets no Mist data. The test fixture
  (`adapters.test.ts:117,121-122`) and `docs/spec/p2-oem.md:10` carry the same names.
- **Mist warranty and contract fields.** `warranty_start` (string, "only returned for onboarded
  (claimed) devices", e.g. `2022-09-01`), `warranty_end` (string, e.g. `2042-11-28`), `warranty_time`
  (integer, "Timestamp when warranty needs to be renewed"), `warranty_type` (e.g. "Enhanced Hardware
  Warranty", `WTY00002`), `warranty`, `contract_start_date` (e.g. `2022-09-01`), `contract_end_date`
  (e.g. `2028-10-01`), `contract_id`, `contract_type`, `service_contract_no`, `has_support` (boolean,
  "covered under active support contract"), `support_contract_status` (Active, Declined, EOL, Service
  Available). `contract_id`, `warranty_type` and `contract_type` are read correctly today. Because the
  date names are wrong, Mist coverage always comes back not covered.
- **Mist claim.** operationId `addOrgInventory`. Request body: JSON array of strings ("List of Claim
  Codes", uniqueItems), e.g. `["6JG8E-PTFV2-A9Z2N","DVH4V-SNMSZ-PDXBR"]`. Response
  `response_inventory`: `added[]`, `duplicated[]`, `error[]` ("Claim codes rejected"), `reason[]`
  (uniqueItems; no positional link to `error[]` documented), `inventory_added[]` and
  `inventory_duplicated[]` (`{mac, magic, model, serial, type}`; `magic` is the code without dashes,
  e.g. `6JG8EPTFV2A9Z2N`). Both 200 and 400 reference the same response `OrgInventoryAdd` ("OK - if
  any of entries are valid or there's no errors"). Other responses: 401, 403, 404, 429. The 100-code
  batch size (`MIST_CLAIM_BATCH`) is not documented. As written, a batch where no code is valid loses
  its `duplicated` codes and the per-code reasons.
- **Mist auth.** `securitySchemes.apiToken`: "Format: Authorization: Token {apitoken}". A token has
  the privileges of the admin it was generated for. "An API token is automatically removed if it is
  not used for more than 90 days." "SSO admins cannot generate admin API tokens. Use organization API
  tokens when scoped Org/Site privileges are needed." Operational note for the property description:
  use an org API token, and note that it is removed after 90 days unused.
- **Mist rate limits.** HPE/Juniper overview: "HPE Mist limits API calls to 5,000 per hour"; more on
  request via support ticket; the login API is rate-limited after three failures. OpenAPI 429: "The
  API Token used for the request reached the 5000 API Calls per hour threshold". "Rate limiting is done
  on an individual token basis". Older mist.com page (2018): "reset at the hourly boundary".
  Recommended: treat 429 as "stop this run" (`if (response.status === 429) break` in `mistClaim` before
  `claims.ts:141`). Optional: batch serials and models comma-separated to cut lookup calls.
- **Mist hosts.** Global 01 `api.mist.com`, Global 02 `api.gc1.mist.com`, Global 03
  `api.ac2.mist.com`, Global 04 `api.gc2.mist.com`, Global 05 `api.gc4.mist.com`, EMEA 01
  `api.eu.mist.com`, EMEA 02 `api.gc3.mist.com`, EMEA 03 `api.ac6.mist.com`, EMEA 04
  `api.gc6.mist.com`, APAC 01 `api.ac5.mist.com`, APAC 02 `api.gc5.mist.com`, APAC 03
  `api.gc7.mist.com`. To find the host, take the portal URL (`manage.<region>`) and replace `manage`
  with `api`. The OpenAPI `servers` list has the same 12 hosts. Tokens and org ids are cloud-specific.

Sources:

- M1: https://raw.githubusercontent.com/meraki/openapi/master/openapi/spec3.json (info.version
  1.76.0, "Date: 04 November, 2026"; includes `components.securitySchemes` and the
  `claimIntoOrganizationInventory` description).
- M2: https://developer.cisco.com/meraki/api-v1/get-organization-inventory-devices/ (page shows
  04 November 2026, v1.76.0).
- M3: https://github.com/meraki/dashboard-api-python/blob/main/meraki/api/organizations.py
  (`getOrganizationInventoryDevices`, array params as `f'{k}[]'`; `claimIntoOrganizationInventory`
  body params `orders`, `serials`, `licenses`).
- M4: https://developer.cisco.com/meraki/api-v1/authorization/ (no date shown).
- M5: https://developer.cisco.com/meraki/api-v1/getting-started/
- M6: https://github.com/meraki/dashboard-api-python/blob/main/meraki/session/base.py
- M7: https://developer.cisco.com/meraki/api-v1/claim-into-organization-inventory/ (04 Nov 2026,
  1.76.0).
- M8: https://developer.cisco.com/meraki/api-v1/errors/
- M9: https://developer.cisco.com/meraki/api-v1/rate-limit/ (no date shown).
- M10: https://github.com/meraki/dashboard-api-python/blob/main/meraki/config.py
  (`DEFAULT`/`CANADA`/`CHINA`/`INDIA`/`UNITED_STATES_FED_BASE_URL`).
- H1: https://raw.githubusercontent.com/mistsys/mist_openapi/master/mist.openapi.json (info.version
  2610.1.0, "Date: October 1, 2026"; the spec behind the Mist API Reference). Parts used:
  `paths['/api/v1/orgs/{org_id}/inventory'].post`, `components.schemas.js_inventory_item`,
  `components.examples.JsiInventorySearchExample`, `components.responses.OrgInventoryAdd`,
  `components.schemas.response_inventory`, `components.securitySchemes.apiToken`,
  `components.responses.HTTP429`, tag "Orgs API Tokens", `servers[]`.
- H2: https://networkingdocs.hpe.com/documentation/us/en/software/mist/api/http/api/orgs/jsi/list-org-jsi-past-purchases
  (rendered from the spec; the page body was not readable by fetch).
- H3: https://networkingdocs.hpe.com/documentation/us/en/software/mist/automation-integration/topics/concept/restful-api-overview.html
  (redirected from juniper.net; no date shown).
- H4: https://www.mist.com/documentation/api-rate-limiting/ ("Modified on December 5, 2018").
- H5: https://networkingdocs.hpe.com/documentation/us/en/software/mist/automation-integration/topics/topic-map/api-endpoint-url-global-regions.html
  (redirected from juniper.net; no date shown).

## HPE GreenLake, FortiCloud and FortiZTP

| Item | App assumes | Source says | Verdict | Source |
|---|---|---|---|---|
| GreenLake base URL and API version | `https://global.api.greenlake.hpe.com`, `/devices/v1/...` (`oem-messages.now.ts:156,164,168,174`) | Same host; v1 is stable; v1beta1 stopped working 2025-05-05; v2beta1 is beta | matches | G1, G2, G3 |
| GreenLake add devices | `POST /devices/v1/devices`, 25 per call, `{"network":[...]}` only (`claims.ts:54,165`) | Max 5 devices per request; `compute`, `network` and `storage` all required | differs | G2, G1, G3 |
| GreenLake add and update are asynchronous | Any 2xx = done; response headers not exposed (`claims.ts:167,187`, `http.ts:12-15`, `rest-port.ts:63`) | 202 means input validated; progress at the `Location` URL (`/devices/v1/async-operations/{id}`) | partially | G2, G1 |
| GreenLake find device | `GET .../devices/v1/devices?filter=serialNumber eq '${serial}'`, reads `items[0].id` (`oem-messages.now.ts:168`, `claims.ts:180`) | Same filter syntax and response fields | matches | G2, G1 |
| GreenLake assign subscription | `PATCH .../devices/v1/devices?id=${device_id}`, `{"subscription":[{"id"}]}`, inherits `Content-Type: application/json` (`oem-messages.now.ts:161,171-176`) | Request body accepts only `application/merge-patch+json` | differs | G2, G3, G4 |
| GreenLake authentication | `oauth2` with a profile attached on the instance (`oem-messages.now.ts:148-149,158`) | Client credentials grant; per-workspace token URL; tokens valid 15 minutes | matches | G5, G6, G7 |
| FortiCloud Asset Management v3: base URL, products/list | `POST https://support.fortinet.com/ES/api/registration/v3/products/list` `{"serialNumber"}`, one call per serial (`oem-messages.now.ts:79,87-93`) | Same base and resource; `serialNumber` or `expireBefore` required in the body | matches | F1, F2 |
| FortiCloud products/list response | `assets[].entitlements[]`, `asset.contractNumber`; API `status` ignored (`adapters.ts:127-143`) | `contractNumber` sits under `assets[].contracts[]`; `status` 0 means success | partially | F1, F3 |
| FortiCloud rate limits vs coverage sync | 200 serials per batch, one call each, looping up to 120 s (`oem-sync.ts:83-85`) | 100 calls per minute, 1000 per hour, 10 errors per hour | differs | F1 |
| FortiCloud products/register | 10 per batch, `{"registrationUnits":[{serialNumber, description, isGovernment}]}`, no `accountId` (`claims.ts:58,200-206`) | 10 per batch confirmed; request schema only on FNDN (login) | unverifiable | F1, F3, F4, F2 |
| FortiCloud OAuth | `oauth2` profile; IAM API user with client_id `assetmanagement` (`oem-messages.now.ts:5-7,81`) | Password grant at `customerapiauth.fortinet.com`, JSON body; client_id matches; no client secret issued | partially | F5, F1, G7 |
| FortiZTP provision to FortiManager | `PUT https://fortiztp.forticloud.com/public/api/v1/devices/${serial}`, `fortiManagerOid` as a string, no `deviceSN` (`oem-messages.now.ts:183,191-196`, `claims.ts:217`) | Primary reference needs login; third-party SDKs suggest a v1/v2 mix | unverifiable | F6, F7, F8, F9, F10 |
| FortiZTP client_id | Not stated in code or docs (`oem-messages.now.ts:147-149,185`) | From the credentials ZIP; official examples omit FortiZTP; SDKs use `fortiztp` | unverifiable | F5, F9, F10 |
| FortiZTP and FortiCloud error body | `errorText` reads `errors[0]`, `message`, `detail` (`http.ts:25-29`) | `{"error", "error_description"}` | partially | F9, F5 |

Notes:

- **Source quality.** GreenLake items are checked against HPE's official OpenAPI bundle (OpenAPI
  3.1.0, version "latest", downloaded 2026-11-07), the developer guide and the changelog (latest entry
  2026-June). The FortiCloud Asset Management v3 and FortiZTP API references are on FNDN, which
  redirects to a login page, so no primary endpoint schema was readable. Fortinet items use the
  official docs.fortinet.com IAM guide, the FortiZTP Administration Guide and a Fortinet-staff KB
  article (vendor-authored, not the API reference). Request and response details beyond that come
  only from third-party PyPI SDKs, whose source was read but not run.
- **GreenLake version.** The developer guide gives the endpoint as
  `https://global.api.greenlake.hpe.com/` with `/devices/v1/devices`,
  `/devices/v1/async-operations/{id}` and `/devices/v1/devices/{id}`. v2beta1 POST, PATCH and GET also
  exist (beta); v2beta1 POST takes one flat device object `{serialNumber, macAddress, deviceType, ...}`.
- **GreenLake add devices.** operationId `postDevicesV1`, schema `DevicesPostRequest` with
  `required: ['compute','network','storage']`. Each network item requires `macAddress` and
  `serialNumber` (`tags` optional); compute and storage items require `partNumber` and `serialNumber`.
  "Accepts a maximum of five devices per request, combining the count of network, compute, and storage
  devices." Needs `ccs.device-management.edit`. Rate limit 50 requests per minute per workspace, 429
  above it (changelog 2026-June). Optional query parameter `dry-run`. The app requires a MAC
  (`claims.ts:160`).
- **GreenLake async operations.** POST and PATCH "provide an asynchronous response and will always
  return 202 Accepted if basic input validations are successful. The location header in the response
  provides the URI to be invoked for fetching the progress". The 202 response has a `Location` header
  (example `/devices/v1/async-operations/22d6fbfb-...`) and a body `{code, status, transactionId}`.
  `GET /devices/v1/async-operations/{id}` returns `status` (INITIALIZED, RUNNING, FAILED, SUCCEEDED,
  TIMEDOUT, PAUSED), `result`, `progressPercent` and `suggestedPollingIntervalSeconds`, with a
  per-device breakdown keyed by serial number. Operation resources disappear 24 hours after a
  terminal state. A later `find_device` miss already catches a failed add ("device not in the
  GreenLake workspace yet"); a failed subscription PATCH goes unnoticed.
- **GreenLake find device.** operationId `getDevicesV1`; query parameters `filter` (OData 4.0 subset;
  example `serialNumber eq 'STIAPL6404'`), `filter-tags`, `sort`, `select`, `limit` (max and default
  2000) and `offset`. The 200 response requires `items` and `count` (plus `offset`, `total`); each item
  requires `id` (uuid), `partNumber`, `serialNumber` and `type`; `item.subscription[]` has `id` (uuid),
  `key`, `tier` and more. Rate limit 160 requests per minute per workspace; needs
  `ccs.device-management.view`. The guide says reserved characters in string literals must be
  percent-encoded.
- **GreenLake find device, optional hardening (verdict matches, unverified without an instance).** The
  endpoint holds raw spaces and quotes, which RFC 3986 requires to be percent-encoded. If RESTMessageV2
  rejects or mangles the URL, change `oem-messages.now.ts:168` to
  `"https://global.api.greenlake.hpe.com/devices/v1/devices?filter=serialNumber%20eq%20%27${serial}%27"`.
- **GreenLake assign subscription.** operationId `patchDevicesV1`; query parameter `id` (required;
  array of uuid, style form, explode true; "Maximum five devices per request"). Body schema:
  `subscription[]` items `{id (required, string)}`, `application {id}`, `region`,
  `tenantPlatformCustomerId`. "Only one operation is supported in a single API call." An empty
  `subscription` array removes the subscription. Async 202 + `Location`. Rate limit 40 requests per
  minute per workspace. Needs `ccs.device-management.edit`. In GET responses, `subscription[].id` is a
  uuid, distinct from `subscription[].key` (e.g. `SIEIAASTEST018ID`), so the account value must be the
  subscription's UUID, not its key (account label `staging.now.ts:154`: "HPE GreenLake (subscription
  id)"). ServiceNow: "the value defined for the HTTP method overrides the value from the parent REST
  message" when both set the same header.
- **GreenLake auth.** Create a personal API client (service "GreenLake Cloud Platform"), up to 7 per
  workspace. Tokens are OAuth bearer tokens and inherit the creating user's permissions. "GreenLake
  tokens stay valid for 15 minutes." The token is issued with `grant_type=client_credentials`,
  `Content-Type: application/x-www-form-urlencoded`, at
  `https://global.api.greenlake.hpe.com/authorization/v2/oauth2/<workspace id>/token` (workspace id as
  hex without hyphens). ServiceNow's third-party OAuth provider supports the Client Credentials grant.
  Optional comment for `oem-messages.now.ts:147-151`: "GreenLake: Client Credentials grant, token URL
  https://global.api.greenlake.hpe.com/authorization/v2/oauth2/<workspaceId>/token, API client user
  needs Devices and Subscription edit permission."
- **FortiCloud products/list.** KB: "FortiCare Registration API v3 Resource Base:
  /ES/api/registration/v3/" on support.fortinet.com; resources `products/list`, `products/register`,
  `products/details`, `products/description`, `products/location`, `licenses/register`,
  `licenses/download`. Example `curl --request POST
  'https://support.fortinet.com/ES/api/registration/v3/products/list'` with Bearer auth and JSON.
  "serialNumber or expireBefore must be used in the POST body." For Organization scope the body must
  also carry `accountId`: if the Provider's IAM API user is Organization-scoped, `products_list` content
  must include `"accountId": <number>` (`oem-messages.now.ts:91`).
- **FortiCloud response.** KB sample: `{"build":"1.0.0","error":null,"message":"Request processed
  successfully","status":0,"token":...,"version":"3.0","assets":[{"description","entitlements":
  [{"endDate","level","levelDesc","startDate","type","typeDesc"}],"isDecommissioned","productModel",
  "registrationDate","serialNumber","warrantySupports","assetGroups","contracts":[{"contractNumber",
  "sku","terms":[{"endDate","startDate","supportType"}]}],"productModelEoR","productModelEoS"}]}`.
  The entitlement fields `levelDesc`, `typeDesc`, `startDate` and `endDate` match. The third-party
  hfortix-forticare SDK corroborates "status: API call status code, 0 means success". Today HTTP status
  alone decides success (`adapters.ts:19-28`), so an HTTP-200 API error can stamp serials as checked
  with no coverage.
- **FortiCloud limits.** KB "Limits and Quotas": maximum 100 calls per minute, 1000 calls per hour,
  10 errors per hour; maximum 10 units per batch registration; maximum 5 errors per batch
  registration. Coverage loads 200 stale serials at a time and calls `products_list` once per serial
  (`adapters.ts:125-126`) until `x_daas_ham.job.budget_seconds` (default 120 s), every 4 hours. The
  claims budget (`x_daas_ham.oem.claim.max_calls`, default 8 per vendor per 5-minute run,
  `entry/oem-claims.ts:15`; about 96 per hour) is within the limits.
- **FortiCloud register.** The response envelope (KB sample) has `status` (0 = success), `message`,
  `error`, `build`, `version`, `token`. Third-party hfortix-forticare gives the top-level body as
  `{accountId (int; "Optional for API user with Local scope, mandatory for Org scope"),
  registrationUnits[], locations[]}`. Third-party pyfortiassetmgmt sends
  `registrationUnits:[{serialNumber, cloudKey, isGovernment}]`; its docstring also lists
  `contractNumber`, `folderId`, `description`, `assetGroupIds`, `replacedSerialNumber` and
  `additionalInfo`, but where `description` belongs is not confirmed. Batch size 10, the
  `serialNumber`/`isGovernment` shape and the status/message handling agree with the KB and both SDKs.
- **FortiCloud OAuth.** IAM guide "Accessing FortiAPIs" (26.4.0): `POST
  https://customerapiauth.fortinet.com/api/v1/oauth/token/` with `Content-Type: application/json` and
  body `{"username":"<apiId>","password":"<password>","client_id":"<clientId>","grant_type":"password"}`.
  The clientId is "the FortiCloud service ID ... listed in the credentials ZIP file, such as "iam",
  "assetmanagement", or "forticameracloud"". Response 200 `{access_token, expires_in (e.g. 3660),
  token_type "Bearer", scope "read write", refresh_token, message, status}`. Auth failure returns 400
  (not 401), e.g. `{"error":"invalid_grant",...}`. Refresh: same URL with `{client_id,
  grant_type:"refresh_token", refresh_token}`. The KB adds that the client_id "normally should be
  assetmanagement" and to keep the trailing slash. ServiceNow's third-party OAuth provider offers a
  "Resource owner password credentials" grant, but Client Secret is a required field. The docs do not
  say whether the token body may be form-encoded.
- **FortiZTP.** Administration Guide (26.1.0 / 26.1.a, "API" page): "There is an API available for
  FortiZTP ... supported API calls at the FortiZTP REST API documentation" (an FNDN link that needs
  login). "The API usage limit is 2 000 calls per hour." "You can do a single API call on multiple
  devices by entering multiple device serial numbers." "The FortiZTP v2.0 API is available." In the UI,
  FortiManagers are added under Settings > FortiGate > Provision Target (serial number and IP/FQDN)
  before provisioning. The app's 8 calls per 5 minutes (about 96 per hour) is within 2000 per hour.
  Account label `staging.now.ts:155`: "FortiZTP (FortiManager OID)".
- **FortiZTP, third-party only.** pyfortiztp 1.0.1 (v1): host
  `https://fortiztp.forticloud.com/public/api/v1`, `PUT /devices` (collection) with an array body
  `[{deviceSN, deviceType, provisionStatus:'provisioned', provisionTarget:'FortiManager',
  externalControllerIp, externalControllerSn}]`, success 204 No Content; `GET /devices/{deviceSN}`.
  hfortix-fortiztp 0.5.164 (v2): base `https://fortiztp.forticloud.com/public/api`, single-device
  `PUT /v2/devices/{deviceSN}` with `{deviceSN, deviceType, provisionStatus, provisionTarget, region?,
  externalControllerSn?, externalControllerIp?, fortiManagerOid (int, "Preferred over
  externalControllerSn/externalControllerIp"), scriptOid?}`; bulk `PUT /v2/devices`; FortiManager OIDs
  from `GET /v2/setting/fortimanagers`. Enums: `deviceType` FortiGate, FortiAP, FortiSwitch,
  FortiExtender; `provisionStatus` provisioned, unprovisioned, hidden, incomplete; `provisionTarget`
  FortiManager, FortiGateCloud, FortiEdgeCloud, ExternalController. Both SDKs suggest the app mixes the
  v1 base path with the v2 field `fortiManagerOid`: v1 has no documented per-serial PUT and uses
  `externalControllerSn`/`Ip` instead.
- **FortiZTP client_id.** The token endpoint and password grant are the same as for FortiCloud. The
  third-party pyfortiztp (client_id default `fortiztp`) and hfortix-fortiztp
  (`DEFAULT_CLIENT_ID = 'fortiztp'`) both use `fortiztp`. The same ServiceNow ROPC client-secret caveat
  as FortiCare applies. Suggested comment for `oem-messages.now.ts:147-151`: "FortiZTP: FortiCloud IAM
  API user, password grant at https://customerapiauth.fortinet.com/api/v1/oauth/token/, client_id from
  the credentials ZIP (normally "fortiztp")".
- **FortiZTP errors.** pyfortiztp README ("Error messages are provided as is, from the FortiZTP API"):
  `{"error":"invalid_request","error_description":"Device testSN doesn't exist in this account"}`;
  success 204 No Content. The official IAM page shows the same `{error, error_description}` shape for
  the token endpoint. Success handling (any 2xx, `claims.ts:213-220`) matches.

Sources:

- G1: https://developer.greenlake.hpe.com/docs/greenlake/services/device-management/public (Overview
  and Developer guide, including "Add devices" payload and Filtering section; "Last updated 3 months
  ago").
- G2: https://developer.greenlake.hpe.com/_bundle/docs/greenlake/services/device-management/public/openapi/nbapi-inventory/openapi.json?download
  (OpenAPI 3.1.0, info.version "latest", fetched 2026-11-07; parts used: `paths./devices/v1/devices`
  get, post and patch, `components.schemas.DevicesPostRequest`, 202 `headers.Location`,
  `/devices/v1/async-operations/{id}`).
- G3: https://developer.greenlake.hpe.com/docs/greenlake/services/device-management/public/openapi/changelog
  (latest entry 2026-June).
- G4: https://www.servicenow.com/docs/bundle/yokohama-api-reference/page/integrate/outbound-rest/task/t_DefineAnHTTPHeader.html
  (Yokohama, updated 2025-01-30).
- G5: https://developer.greenlake.hpe.com/docs/greenlake/guides/public/authentication/authentication
  ("Last updated 1 year ago").
- G6: https://developer.greenlake.hpe.com/docs/greenlake/services/credentials/public/msp-token-exchange
- G7: https://www.servicenow.com/docs/r/api-reference/web-services/t_UseAThirdPartyOAuthProvider.html
  (Use a third-party OAuth provider, release Brazil, updated 2026-09-10).
- F1: https://community.fortinet.com/t5/FortiCloud-Products/Technical-Tip-API-how-to-retrieve-list-of-registered-units-for/ta-p/194760
  (Fortinet-staff KB technical tip, created 2021-10-22, page shows a 2026-04-16 update;
  vendor-authored, not the API reference).
- F2: https://fndn.fortinet.net (API reference; login required, not readable).
- F3: https://pypi.org/project/hfortix-forticare/0.5.164 (third-party SDK;
  `hfortix_forticare/api/v3/products/register.py`).
- F4: https://pypi.org/project/pyfortiassetmgmt/1.0.1 (third-party SDK;
  `pyfortiassetmgmt/models/products.py`).
- F5: https://docs.fortinet.com/document/forticloud/26.4.0/identity-access-management-iam/19322
  (Accessing FortiAPIs, FortiCloud 26.4.0).
- F6: https://docs.fortinet.com/document/fortiztp/26.1.a/administration-guide/182159/api
- F7: https://fortinetweb.s3.amazonaws.com/docs.fortinet.com/v2/attachments/1258992d-127d-11f1-8b43-d2943efe5b2f/FortiZTP-Administration_Guide.pdf
  (FortiZTP 26.1.0 Administration Guide).
- F8: https://fndn.fortinet.net/index.php?/fortiapi/1584-fortiztp/ (FortiZTP API reference; login
  required).
- F9: https://pypi.org/project/pyfortiztp/1.0.1 (third-party SDK and README).
- F10: https://pypi.org/project/hfortix-fortiztp/0.5.164 (third-party SDK).

## Check Point Zero Touch, ShipEngine and EasyPost

| Item | App assumes | Source says | Verdict | Source |
|---|---|---|---|---|
| Zero Touch base URL and path | `POST https://zerotouch.checkpoint.com/api/v1/gateways`, once per device (`oem-messages.now.ts:203,210-215`, `claims.ts:222-226`) | Every command is `POST https://zerotouch.checkpoint.com/ZeroTouch/web_api/v2/<command>`; no `/api/v1/gateways` | differs | K1, K2, K3, K4 |
| Zero Touch authentication | `X-API-Key: ${api_key}` from one password2 property (`oem-messages.now.ts:214`, `rest-port.ts:17`) | `login` with `api-client-id` and `api-key` returns a `sid`, sent as `X-chkp-sid`; no `X-API-Key` | differs | K5, K6, K7 |
| Zero Touch claim body | `{serialNumber, template}`; requires serial (`claims.ts:223-226`) | `claim-gateway` takes `object-name`, `account-id` (int), `template-id` (int), `mac`; no serial | differs | K1, K8, K2, K9 |
| ShipEngine base URL, auth header, labels path | `POST https://api.shipengine.com/v1/labels`, header `API-Key: ${api_key}` (`shipping.now.ts:15,22-27`) | Same | matches | S1, S2, S3, S4 |
| ShipEngine `shipment.carrier_id` | Not sent; `service_code` from a property (`domain/shipping.ts:87-95`) | `carrier_id` is required | differs | S1, S4 |
| ShipEngine `ship_to` / `ship_from` | Field names as spec; empty optionals sent as `''` (`domain/shipping.ts:58-76`) | Names match; `ship_from.phone` and `state_province` required with minLength 1 | partially | S1 |
| ShipEngine packages and label format | `weight {value, unit:'kilogram'}`, `label_messages.reference1`, `label_format:'pdf'` (`domain/shipping.ts:92-94`) | Same | matches | S1, S4 |
| ShipEngine label response | `label_id`, `tracking_number`, `carrier_code`, `label_download.pdf`/`href`, `shipment_cost` (`domain/shipping.ts:105-117`) | Same; sample currency lowercase; label URL valid 90 days | matches | S1, S4 |
| ShipEngine track webhook payload | `data.tracking_number`, `status_code`, descriptions, dates, `events[]` (`domain/shipping.ts:182-200`) | Same fields | matches | S5, S6, S1 |
| ShipEngine `status_code` values | 8 codes mapped (`domain/shipping.ts:120-129`) | Enum UN, AC, IT, DE, EX, AT, NY, SP | matches | S1, S7, S6 |
| ShipEngine webhook URL auth | `?token=` in the URL (`entry/shipping.ts:146-147`, `rest.now.ts:178-186`) | Query strings not documented; custom headers and RSA-SHA256 signatures documented | partially | S1, S5, S8 |
| ShipEngine webhook delivery and retries | A delivery held off by the Shipment's tracking lock is answered 503 for the aggregator to send again (`entry/shipping.ts` `postTrackingUpdate`, commit e197f67) | 10 s to answer 2xx; then at most two more attempts, typically 30 minutes apart, and the event is dropped | differs | S9 |
| EasyPost Event envelope | Any body with `result.tracking_code` is a tracking update (`domain/shipping.ts:201-203`) | `result` can be another object type, e.g. Insurance, which also has `tracking_code` | partially | E1, E2, E3 |
| EasyPost Tracker fields and status values | `tracking_code`, `status`, `status_detail`, `est_delivery_date`; 10 statuses (`domain/shipping.ts:131-142,202-212`) | Same | matches | E4 |
| EasyPost `tracking_details[]` | Field names; last element is the latest scan (`domain/shipping.ts:205-218`) | Field names match; order not documented | partially | E4 |
| EasyPost webhook URL auth | `?token=` in the URL | HMAC signature, Basic auth in URL, up to 3 custom headers; query strings not mentioned | partially | E5, E3 |

Notes:

- **Zero Touch commands.** Documented commands: `login`, `logout`, `show-all-accounts`,
  `show-all-templates` (body `{"account-ids":[int]}`, response `template-id`, `account-id`, `name`,
  `plan`, ...). Small Office (Quantum Spark) gateways use `add-template`, `show-template`,
  `set-template`, `claim-gateway`, `show-claimed-gateway`, `show-claimed-gateway-status` and
  `unclaim-gateway`. Gaia gateways use the same set with a `gaia-` prefix (`claim-gaia-gateway` etc.).
  Success is HTTP 200; failure is 400, 401 or 500 with `{message, messages[], code}`. No rate limits
  are stated. The comment at `oem-messages.now.ts:150` says the endpoint is still to be confirmed.
- **Zero Touch auth.** `POST .../ZeroTouch/web_api/v2/login`, `Content-Type: application/json`, body
  `{"api-client-id": string (mandatory), "api-key": string (mandatory)}`, both generated in the Zero
  Touch Web Portal. The 200 response carries `sid`, `user`, `url` and `last-login-was-at`. `X-chkp-sid`
  is "mandatory in all API calls except the login API". `POST .../logout` with `X-chkp-sid` ends the
  session (`{"code":"17999","message":"Logout succeeded"}`). Admin Guide: keys are generated under
  Options > Manage API Key, one key per user, validity 1-180 days (default 90), shown only once.
- **Zero Touch claim.** `claim-gateway` ("Claims a Small Office Gateway with a template-id"), headers
  `Content-Type: application/json` and `X-chkp-sid`. Mandatory: `object-name` (string, the gateway's
  name), `account-id` (int, the User Center account that owns gateways and templates), `template-id`
  (int), `mac` (string, e.g. `xx:xx:xx:7A:B3:4E`). Optional: `under-construction` (boolean, default
  false). The 200 response is an array with `gateway-configuration` (`template-name` ...),
  `creation-time`, `last-modify-time` and `gateway-status` (`status-value` "set", `display-status`
  "Ready to deploy"). Template ids come from `show-all-templates`. Gaia appliances use
  `claim-gaia-gateway` with the same four mandatory fields. Today the customer account is one string in
  `x_daas_ham_cloud_account.account_id`, labelled "Check Point Zero Touch (template)"
  (`staging.now.ts:156`); success means any 2xx; test at `claims.test.ts:151-157`. The demo model in
  `demo-seed.ts:84` is `CPAP-SG3600` (Quantum 3600); the researcher's unverified understanding is that
  it is a Gaia appliance, which would need `claim-gaia-gateway`.
- **ShipEngine basics.** OpenAPI "ShipEngine API" 1.1.202604070904: servers
  `[https://api.shipengine.com]`, `/v1/labels` POST, operationId `create_label` ("Purchase Label");
  security scheme `api_key` (apiKey, header `API-Key`). Missing or invalid key gives 401. Sandbox keys
  start with `TEST_`. Rate limit 200 requests per minute by default (sandbox 20), 429 with
  `Retry-After` above it. Error body `{request_id, errors:[{error_source, error_type, error_code,
  message, ...}]}`, which `errorText` (`http.ts:25-29`, `errors[0].message`) already reads. The key
  comes from `x_daas_ham.shipping.api_key` (`rest-port.ts:18`).
- **ShipEngine carrier_id.** `shipment_request` has `required: ["carrier_id", "service_code",
  "ship_to", "packages"]`. `carrier_id` is an se_id string (pattern `^se(-[a-z0-9]+)+$`, e.g.
  `se-28529731`), "The carrier account that is billed for the shipping charges". "Either ship_from or
  warehouse_id must be set". The docs example sends `"carrier_id": "se-123456", "service_code":
  "ups_ground"` and says to "use the standard label creation endpoint (POST /v1/labels) with explicit
  carrier_id and service_code". Rate shopper and `shipping_rule_id` are the alternatives. The app's
  service code defaults to `ups_standard` (`x_daas_ham.shipping.service_code`, `shipping.now.ts:72-79`).
- **ShipEngine addresses.** Spec field names: `name`, `phone`, `email`, `company_name`,
  `address_line1`, `address_line2`, `address_line3`, `city_locality`, `state_province`,
  `postal_code`, `country_code`, `address_residential_indicator` (unknown, yes, no), `instructions`.
  `ship_to` requires `name`, `address_line1`, `city_locality`, `state_province`, `postal_code`
  (`country_code` optional, length 2). `ship_from` requires `name`, `phone`, `address_line1`,
  `city_locality`, `state_province`, `postal_code`, `country_code`. `phone` and `state_province` have
  minLength 1; `company_name` and `address_line2` are nullable. `state_province`: "For some countries
  (including the U.S.) only abbreviations are allowed." On return labels `ship_from` is the Site
  (`cmn_location.phone`). The app's `addressProblem` (`domain/shipping.ts:58-62`) requires only name,
  line1, city, postal code and country.
- **ShipEngine packages.** `packages[].weight` is required: `{value (number), unit (pound, ounce, gram,
  kilogram)}`. `label_messages` (`reference1`-`reference3`) is listed as required but nullable with
  default null. Line limits per carrier: UPS 2 lines x 35 characters, FedEx 3 x 35/30, USPS 3 x 60.
  `label_format` is pdf, png or zpl (default pdf, "supported by all carriers"); `label_download_type`
  defaults to `url`.
- **ShipEngine label response.** `create_label_response_body` requires `label_id`, `status`
  (processing, completed, error, voided), `tracking_number`, `carrier_id`, `carrier_code`,
  `service_code`, `shipment_cost {currency, amount}` and `label_download {href, pdf, png, zpl}`. The
  sample has `"currency": "usd"`, which the app uppercases (default `EUR`). "The URL will remain valid
  for 90 days." Operational note: `x_daas_ham_shipment.label_url` expires after 90 days, so download or
  attach the PDF if it must be kept.
- **ShipEngine track payload.** `resource_url` (e.g.
  `https://api.shipengine.com/v1/tracking?carrier_code=usps&tracking_number=...`), `resource_type`
  `API_TRACK` (event `track`), and `data`: `label_url`, `tracking_number` (required), `status_code`
  (required), `carrier_detail_code`, `status_description`, `carrier_status_code` (required),
  `carrier_status_description`, `ship_date`, `estimated_delivery_date` (ISO 8601, sample
  `2020-07-06T00:00:00` without zone), `actual_delivery_date`, `exception_description`, `events[]`
  (required). Each event has `occurred_at` (required, UTC), `carrier_occurred_at`, `description`,
  `city_locality`, `state_province`, `postal_code`, `country_code`, `company_name`, `signer`,
  `event_code`, `event_description`, `carrier_detail_code`, `status_code` (optional, null in sample
  events), `latitude`, `longitude`. The endpoint must return 2xx within 10 seconds; otherwise up to two
  more attempts, typically 30 minutes apart. The app does not check `resource_type`. Because event
  `status_code` is often null, the stored event status becomes `unknown`; this is acceptable, since
  the shipment status comes from `data.status_code`.
- **ShipEngine status codes.** UN Unknown, AC Accepted, IT In Transit, DE Delivered, EX Exception,
  AT Delivery Attempt, NY Not Yet In System, SP Delivered To Collection Location. The webhook schema
  table lists only UN, AC, IT, DE, EX, AT, NY. GET tracking also has `status_detail_code` (e.g.
  `OUT_FOR_DELIVERY`, `RETURN_TO_SENDER`), which the webhook schema does not list. Semantic choice to
  review (not a contract error): SP maps to `delivered`, while EasyPost `available_for_pickup` maps to
  `out_for_delivery` (`domain/shipping.ts:136`); pick one meaning for both. ShipEngine cannot produce
  `returned` or `out_for_delivery` from `status_code` alone.
- **ShipEngine webhooks.** Create webhook: `POST /v1/environment/webhooks` with `event` (batch,
  carrier_connected, order_source_refresh_complete, rate, report_complete, sales_orders_imported,
  track), `url`, `headers: [{key, value}]` ("Array of custom webhook headers"), `name`, `store_id`. One
  URL per event; a duplicate returns 409. Webhooks must be set up in Production. The docs neither allow
  nor forbid query strings. Every webhook is signed with RSA-SHA256 (headers
  `x-shipengine-rsa-sha256-key-id`, `x-shipengine-rsa-sha256-signature`, `x-shipengine-timestamp`;
  signed payload is timestamp + "." + raw body; keys at https://api.shipengine.com/jwks; suggested
  5-minute window). Tracking for non-ShipEngine labels needs
  `POST /v1/tracking/start?carrier_code=&tracking_number=` (204). The docs do not say whether labels
  bought through ShipEngine are subscribed automatically.
- **ShipEngine webhook retries.** The "Webhook Payloads" section of S9, read 2026-11-07, says: "When
  ShipStation API dispatches a webhook, we allow 10 seconds for you to acknowledge you have successfully
  received the payload (your listener should return a 2xx response to us). If we don't receive an
  acknowledgement within 10 seconds, the system will put the payload back into the queue and make a
  maximum of **two additional attempts** to dispatch the given payload. These attempts are typically
  separated by 30 minutes. However, this can swap to other timing intervals under certain conditions.
  If all three attempts receive no response, the event will be removed from the dispatch queue." The
  ShipStation API webhooks overview (S10, "Delivery & Retry Logic") repeats it word for word. So a
  `track` delivery answered 503 because the Shipment's tracking lock was held (commit e197f67) waits
  about 30 minutes for its second attempt, and after three is lost, a *Delivered* update included.
  EasyPost resends a failed delivery up to 6 times (E3). A busy lock must therefore be retried inside
  the app, not by the aggregator.
- **EasyPost Event.** Fields: `object` "Event", `mode`, `description` (e.g. `tracker.created`,
  `tracker.updated`, `insurance.cancelled`, `refund.successful`, `batch.updated`),
  `previous_attributes`, `result` ("See the object attribute on the result to determine its specific
  type"), `status` (completed, failed, in_queue, retrying), `pending_urls`, `completed_urls`,
  `created_at`, `updated_at`, `id`. Delivery is at-least-once, so handlers should be idempotent. The
  Insurance object carries `tracking_code` and `status` new, pending, purchased, failed or cancelled.
  Requests include an `X-Easypost-Event-Type` header. An `insurance.cancelled` Event would today be
  parsed as a tracking update and move a matching shipment to `exception`. The test at
  `shipping.test.ts:134-150` uses `{object:'Event', description:'tracker.updated', result:{...}}`.
- **EasyPost Tracker.** `id` (`trk_...`), `object` "Tracker", `mode`, `tracking_code`, `status`
  (unknown, pre_transit, in_transit, out_for_delivery, delivered, available_for_pickup,
  return_to_sender, failure, cancelled, error), `status_detail` (e.g. label_created,
  arrived_at_facility, out_for_delivery, return, delivery_exception), `signed_by`, `weight`,
  `est_delivery_date` (e.g. `2025-05-09T20:40:17Z`), `shipment_id`, `carrier`, `tracking_details[]`,
  `carrier_detail` (with `est_delivery_date_local`), `delivery_evidence`, `public_url`, `fees`,
  `created_at`, `updated_at`.
- **EasyPost tracking_details.** TrackingDetail: `object`, `message` ("Summary of the scan event"),
  `status`, `status_detail`, `datetime` ("When possible, EasyPost assigns a time zone to the timestamp
  based on the associated tracking_location"), `source`, `tracking_location` (`city`, `state`,
  `country`, `zip`, each nullable). The docs sample lists details oldest-first, but no text promises an
  order.
- **EasyPost webhooks.** EasyPost recommends HMAC: set `webhook_secret`; the signature arrives in
  `X-Hmac-Signature`, validated with `validate_webhook()`. Alternative: Basic auth in the URL
  (`https://username:secret@example.com/easypost-webhook`), which arrives as an `Authorization` header.
  Up to three `custom_headers` `[{name, value}]`, ASCII, under 1000 characters each; `X-EasyPost-*`
  names are blocked, other `X-*` names may be overwritten, values are stored in plaintext. HTTPS needs a
  publicly trusted certificate. Respond within 7 seconds; failures are retried up to 6 times; up to 30
  endpoints. No source IP list is published.

Sources:

- K1: https://sc1.checkpoint.com/documents/Appliances/Zero_Touch_REST_API_Guide/EN/Content/Topics-API/claim-gateway.htm
  (11 February 2025).
- K2: https://sc1.checkpoint.com/documents/Appliances/Zero_Touch_REST_API_Guide/EN/Content/Topics-API/show-all-templates.htm
  (11 February 2025).
- K3: https://sc1.checkpoint.com/documents/Appliances/Zero_Touch_REST_API_Guide/EN/Content/Topics-API/Overview.htm
  (11 February 2025).
- K4: https://sc1.checkpoint.com/documents/R80.20_GA/WebAdminGuides/EN/CP_R80.20_Zero_Touch_REST_API_User_Guide/206383.htm
  (older R80.20 guide, 23 April 2019, same URL pattern).
- K5: https://sc1.checkpoint.com/documents/Appliances/Zero_Touch_REST_API_Guide/EN/Content/Topics-API/login.htm
  (11 February 2025).
- K6: https://sc1.checkpoint.com/documents/Appliances/Zero_Touch_REST_API_Guide/EN/Content/Topics-API/logout.htm
  (11 February 2025).
- K7: https://sc1.checkpoint.com/documents/Appliances/Zero_Touch_Admin_Guide/EN/Content/Topics-AG/Managing-API-keys.htm
  (11 August 2026).
- K8: https://sc1.checkpoint.com/documents/Appliances/Zero_Touch_REST_API_Guide/EN/Content/Topics-API/claim-gaia-gateway.htm
  (11 February 2025).
- K9: https://sc1.checkpoint.com/documents/R80.20_GA/WebAdminGuides/EN/CP_R80.20_Zero_Touch_REST_API_User_Guide/205197.htm
  (R80.20 guide, same parameters).
- S1: https://raw.githubusercontent.com/ShipEngine/shipengine-openapi/master/openapi.json
  (info.version 1.1.202604070904; parts used: `paths./v1/labels.post`, ship_to and ship_from schemas,
  `responses.200`, `components.schemas.status_code`, `tracking_information`, `track_event`,
  `paths./v1/environment/webhooks.post`, `webhook_header`).
- S2: https://docs.shipstation.com/apis/shipengine/docs/guides/auth.md
- S3: https://docs.shipstation.com/apis/shipengine/docs/guides/rate-limits.md
- S4: https://docs.shipstation.com/apis/shipengine/docs/labels/create-a-label
- S5: https://docs.shipstation.com/apis/shipengine/docs/guides/webhooks.md
- S6: https://docs.shipstation.com/apis/shipengine/docs/reference/webhooks-schemas.md
- S7: https://docs.shipstation.com/apis/shipengine/docs/tracking/tracking.md (Tracking Status Codes
  table).
- S8: https://docs.shipstation.com/apis/shipengine/docs/reference/start-tracking.md
- S9: https://docs.shipstation.com/apis/shipengine/docs/guides/webhooks ("Webhook Payloads"), read
  2026-11-07.
- S10: https://docs.shipstation.com/apis/docs/guides/webhooks-overview ("Delivery & Retry Logic"), read
  2026-11-07.
- E1: https://docs.easypost.com/docs/events.md
- E2: https://docs.easypost.com/docs/insurance.md
- E3: https://docs.easypost.com/guides/webhooks-guide.md
- E4: https://docs.easypost.com/docs/trackers.md
- E5: https://docs.easypost.com/docs/webhooks.md

## ServiceNow platform

| Item | App assumes | Source says | Verdict | Source |
|---|---|---|---|---|
| `alm_asset.substatus` choices shipped by the app | 12 separate `sys_choice` Records each ship (`substatus-choices.now.ts:10-188`, ADR 0002) | All share one update name; the built XML holds only `returned_to_lessor` | differs | N1, N2, N3, N4, N5 |
| Added substatus values vs out-of-box | Out-of-box values are not listed; adds `pending_evaluation`, `pending_return`, `returned_to_lessor` (`lifecycle.ts:57-73`) | Out-of-box In stock already has Pending return and Pending evaluation; Retired has Lease return and RMA | differs | N6, N7 |
| `alm_asset.install_status` values | 1 in use, 2 on order, 3 in maintenance, 6 in stock, 7 retired, 8 missing, 9 in transit (`lifecycle.ts:17-25`) | Same values; also Build (11) | matches | N7, N8 |
| Out-of-box substatus values (`STAGE_FIELDS`) | `available`, `reserved`, `pending_disposal`, `lost`, `disposed`, `sold`, `vendor_credit` (`lifecycle.ts:27-50`) | Labels match; only `available` confirmed as a stored value | partially | N6, N7, N8 |
| `alm_asset.cost` and `purchase_date` | `getValue('cost')`; `setValue('cost', number)` (`margin.ts:86-87`, `leases.ts:225`) | Currency field; `getValue()` and a plain number use the session currency | partially | N9, N10, N8 |
| `proc_po` fields and status | `short_description`, `status='requested'`, `ship_to` only if supplied (`procurement.ts:13-18`) | Ship to is documented as required; status labels only | partially | N11, N12 |
| `proc_po_item` and open quantity | Excludes lines only by PO status (`procurement.ts:20-40`) | Line items can be canceled one at a time | partially | N13, N14 |
| `wm_order` state 3 = Closed Complete | `current.state == 3` (`rules.now.ts:105`, `delivery.ts:115-119`) | Docs list state labels only; the number 3 appears only in community posts | unverifiable | N15, N16, N17, N18, N19 |
| `wm_order` fields | `closed_at`, `expected_start`, `estimated_end`, `company`, `location`, `parent`, `short_description`, `work_notes` | task has `closed_at`, `expected_start`, `parent`, `company`, `location`; no source for `estimated_end` or that `wm_order` extends task | partially | N20, N21, N22 |
| `cmdb_ci.last_discovered`, `discovery_source` | `discovery_source === 'ServiceNow'` means ServiceNow Discovery (`in-service.ts:116-118`, `assurance.ts:282`) | Both fields exist; examples pass `ServiceNow`; no page says Discovery writes it | partially | N23, N24 |
| `GlideSysAttachment.write()` and `deleteAttachment()` | As used (`billing.ts:243,255-258`) | Same signatures | matches | N25, N26 |
| `sys_attachment` fields | `table_name`, `table_sys_id`, `file_name` (`billing.ts:268`) | Documented | matches | N27, N28 |
| Scripted REST `request.queryParams` | Each parameter is an array (`rest-api.ts:12`) | Type Array; examples are arrays | matches | N29 |
| `GlideRecord.updateMultiple()` and clearing a field | Clears `billing_period` record by record (`billing.ts` unlinkFees) | `updateMultiple` does not clear values unless set to `'NULL'` | matches | N30 |
| `RESTMessageV2(name, methodName)`, `setStringParameterNoEscape` | As used; app URL-encodes values itself (`rest-port.ts:8,26-28`) | Constructor documented; neither method URL-encodes | matches | N31, N32, N33 |
| `GlideAggregate.groupBy` on date fields | Grouped `start_date`/`end_date` read as `YYYY-MM-DD` (`billing.ts` intervalsByLine) | Format of a grouped `glide_date` key not documented | unverifiable | N34 |
| `setWorkflow(false)` on a global table from the scoped app | Skips the app's before-query rule on `alm_hardware` (`assets.ts:87,94`; `billing.ts:183`; `returns.ts` endLineIfEmpty) | "This method can't be set for cross-scoped applications" | unverifiable | N30 |

Notes:

- **Substatus choices.** SDK 4.14.0 `choice-set-plugin.ts:129-136` refuses `ChoiceSet` on a table the
  project does not define ("Only tables defined in your scope are allowed"). Every `sys_choice` record
  gets the same update name, `choice-set-utils.ts:25-27` `sys_choice_${name}_${element}`, so all 12
  Records write to one update file. `dist/app/update/sys_choice_alm_asset_substatus.xml` (built
  2026-11-07 03:13, newer than the source file) holds exactly one `<sys_choice>`:
  `returned_to_lessor`. This was reproduced with `now-sdk build` in a scratch copy; the build succeeds
  with no warning. `lifecycle.ts:60-73` (`ADDED_SUBSTATUSES`) and `substatus-choices.test.ts` only
  check that the source file and the module agree. The SDK config schema
  (`now.config.schema.json:545-548`) says `legacyChoices` defaults to true; in that mode the choice-set
  XML is "v3 destructive delete-all-then-insert". With `legacyChoices` false it is "v4 additive merge
  with removed_choices tracking, supported on Brazil+, Australia P4+, Zurich P11+", and older instances
  skip it. ServiceNow's application-access docs say nothing about one scope adding choices to another
  scope's field.
- **Substatus collisions.** Xanadu "Set asset states and substates": In stock includes "Pending return"
  and "Pending evaluation"; Retired includes "Lease return" and "RMA". The infocard (2024-01-16) also
  lists "Pending evaluation" under In stock (6). Neither source gives the stored value. The app adds
  `pending_evaluation` (In stock, 6; `lifecycle.ts:68`, `substatus-choices.now.ts:115-128`),
  `pending_return` (In use, 1) and `returned_to_lessor` (Retired, 7).
- **install_status.** The infocard "OOTB Asset - CI State" labels On order (2), In stock (6), Retired
  (7), Missing (8), Build (11), In transit (9), In use (1), In maintenance (3). The SDK
  (`alm_asset.now.ts:950-961`) has `install_status` as an IntegerColumn, default `'1'`, label "State".
  The values are also used at `oem-sync.ts:114` (`!= 7`) and `warehouse.ts:151` (`=== '6'`).
- **Out-of-box substatus values.** In stock has Available, Reserved and Pending disposal; Missing has
  Lost and Stolen; Retired has Disposed, Sold and Vendor credit; In use has "None". The infocard shows
  `--none--` under On order, In transit and In use. The SDK `alm_asset.substatus`
  (`alm_asset.now.ts:703-715`) is a StringColumn dependent on `install_status` with default
  `javascript:if(current.install_status == '6')'available';`, which confirms `available`. No primary
  source gives the other stored values.
- **Currency.** SDK: `cost` is columnType `currency` (`alm_asset.now.ts:246-252`); `purchase_date` is a
  DateColumn labelled "Purchased" (`alm_asset.now.ts:883-895`). Yokohama "Default currency values in
  scripts": `getValue()` "Returns the currency value in the user's session currency as an unformatted
  number"; `getReferenceValue()` returns it in the reference currency; to set the session currency,
  "use a plain number"; for other currencies, "An unformatted number prefixed by a 3-letter currency
  code separated by a semicolon". Asset record fields: Cost is "The price at which the asset was
  purchased." Billing amounts are Decimal fields in EUR or the line's currency (`billing.ts:59`).
- **Procurement.** Brazil "Create a purchase order" lists Number, Due by, Vendor, Ship to ("This field is
  required"), PO date, Status (Canceled, Ordered, Received, Requested, Suspended), Short description and
  others; Vendor is not marked required. The status page: Requested when created, then Ordered, Pending
  delivery, Received or Canceled. Line items: Purchase order, Product Model, Ordered quantity, Received
  quantity, Remaining quantity, Cost, Total cost, Status (Canceled, Ordered, Pending Delivery, Received,
  Requested). Zurich "Cancel a purchase order": unreceived lines are canceled with the PO, and line items
  can also be canceled one at a time. Column names and stored values are not public. The app never sets
  `vendor`; `spare-pool.ts:54` can pass `''` as ship-to when the staging stockroom property is empty;
  `openPurchaseQuantity` (`procurement.ts:31-40`) excludes only POs whose `purchase_order.status` is in
  `received,canceled,cancelled`. Optionally set item `cost` so Total cost and received asset cost are
  not 0.
- **Work orders.** Xanadu and Zurich "Work order states" list Draft, Awaiting Qualification, Qualified,
  Ready for Dispatch, Assigned, Accepted, Work in Progress, Closed Complete, Closed Incomplete and
  Canceled, without numbers; the Work Order Management API lists text labels only. `task.state` in the
  SDK is an IntegerColumn with default `'1'`. Closing child tasks closes the parent work order, and the
  `wm_task` rule "Rollup changes" updates the work order's state. For fields: the SDK task definition
  has `closed_at` (DateTime), `expected_start` (DateTime), `parent` (reference to task), `company`
  (reference to core_company) and `location`; Table API examples show these names on task-derived
  records. FSM "Create a work order" labels: Company, Location, State, "Initiated from", Scheduled start
  ("when the earliest task is scheduled to start") and Estimated end ("when all tasks will be
  completed"). App usage: `field-work.ts:31-40` writes, `delivery.ts:123-129` reads, `margin.ts:143`
  filters on `closed_at`, `rules.now.ts:94` watches `expected_start` and `estimated_end`.
- **CMDB.** SDK `cmdb_ci`: `last_discovered` is a DateTimeColumn "Most recent discovery";
  `discovery_source` is a StringColumn dropdown "Discovery source". IdentificationEngine
  `createOrUpdateCI` source "must be one of the choice values defined for the discovery_source field of
  the cmdb_ci table"; its examples pass `ServiceNow`; `skip_updating_source_last_discovered_to_now`
  controls updates to "the discovery_source and last_discovered fields".
- **Attachments.** `write(GlideRecord record, String fileName, String contentType, String content)`
  "Attaches a specified attachment to the specified record" and returns the sys_id, or null if not
  added (the app ignores the return value). `deleteAttachment(String attachmentID)` returns void. The
  `@servicenow/glide` 27.0.5 typings match. `sys_attachment` in the SDK: `file_name` (String, max 100),
  `table_name` (String, max 80), `table_sys_id`, `content_type`.
- **queryParams.** `RESTAPIRequest.queryParams` type "Array": "The query parameters from the web
  service request." Example: `queryParams.active // [false]`, `queryParams.name // ['now']`.
- **updateMultiple.** "This method sets new values and does not clear existing values. To clear an
  existing value, use the setValue() method and set the field to 'NULL'." Also "use the setValue()
  method instead of direct assignments" and "Do not use this method with the chooseWindow() or
  setLimit() methods when working with large tables." The docs example calls `addQuery`, `setValue`,
  `updateMultiple`, with no `query()`. Optional simplification in `billing.ts` unlinkFees:
  `fee.setValue('billing_period', 'NULL'); fee.updateMultiple()`; the current loop is also correct.
- **RESTMessageV2.** Scoped and global, `sn_ws` namespace: `RESTMessageV2(String name, String
  methodName)`; name is "The name of the REST message record in the REST Message [sys_rest_message]
  table"; methodName is "The name of the HTTP method to use, such as GET/get or PUT/put - case
  insensitive". Example `new sn_ws.RESTMessageV2("Yahoo Finance", "get")` with the comment "Might throw
  exception if message doesn't exist or not visible due to scope." `setStringParameterNoEscape` is
  "equivalent to setStringParameter but does not escape XML reserved characters". The built
  `sys_rest_message` is named "NaaS Cisco Support" with access `package_private`, and its
  `sys_rest_message_fn` has `function_name` `eox_by_pid`. The app casts around typings that declare a
  Rhino constructor. `rest-port.ts` also URL-encodes parameters substituted into JSON body templates
  (e.g. FortiCare `products_list`); this is harmless for alphanumeric serials.
- **GlideAggregate.** `groupBy(String name)`: "May be called numerous times to set multiple group
  fields." No notes on date fields. Time bucketing uses `addTrend(fieldName, timeInterval, numUnits)`.
  Aggregates on currency or price fields use the reference currency; the app aggregates Decimal fields
  only. The table is `x_daas_ham_service_interval`; the code reads `getAggregate('COUNT','')`.
- **setWorkflow.** "This method can't be set for cross-scoped applications" (KB0820691). It is also
  ignored when `deleteMultiple()` cascades. The `billing.ts:183` call on the app's own billing-line
  table is harmless; its comment already explains that the guard has nothing to block.

Sources:

- N1: `node_modules/@servicenow/sdk-build-plugins/src/choice-set-plugin.ts` (SDK 4.14.0).
- N2: `node_modules/@servicenow/sdk-build-plugins/src/choice-set-utils.ts` (SDK 4.14.0).
- N3: `node_modules/@servicenow/sdk-build-core/now.config.schema.json` (`legacyChoices`).
- N4: `/home/user/HAM/dist/app/update/sys_choice_alm_asset_substatus.xml`
- N5: https://www.servicenow.com/docs/r/application-development/c_ApplicationAccessSettings.html
  (Brazil, 2026-09-10).
- N6: https://www.servicenow.com/docs/r/w3Hg5id41C9xrkzqBsUMhA/cdwY_ixvX9WWcJwsgGS3dw (Set asset states
  and substates, Xanadu, 2024-08-01).
- N7: https://downloads.docs.servicenow.com/resource/enus/infocard/predefined-asset-ci-state.pdf
  (OOTB Asset - CI State infocard, 2024-01-16).
- N8: `node_modules/@servicenow/sdk-core/src/fluent/tables/alm_asset.now.ts` (sdk-core 4.14.0).
- N9: https://www.servicenow.com/docs/r/yokohama/platform-administration/currency-administration/currency-values-scripts.html
  (Yokohama, 2025-01-30).
- N10: https://www.servicenow.com/docs/r/it-asset-management/hardware-asset-management/asset-record-fields.html
  (Brazil, 2026-09-10).
- N11: https://www.servicenow.com/docs/r/it-service-management/procurement/t_CreateAPurchaseOrder.html
  (Brazil, 2026-09-10).
- N12: https://www.servicenow.com/docs/r/Sx3eYflWQ2rS18vmPDBm0Q/pLyuDMVkTmYCQDX2xjsHwg (PO status,
  Australia, 2026-03-12).
- N13: https://www.servicenow.com/docs/r/it-service-management/procurement/t_CreateAPurchaseOrderLineItem.html
  (Brazil, 2026-09-10).
- N14: https://www.servicenow.com/docs/r/1zMxrAxr2iK81FYv03BwFA/q5mjqJjD6DiruFk9SgkyJg (Cancel a
  purchase order, Zurich, 2025-07-31).
- N15: https://www.servicenow.com/docs/r/yN_QmjTF0~igG0fSGkXXng/ccbt2xQienYJJefME~xHEw (Work order
  states, Xanadu, 2024-08-01).
- N16: https://www.servicenow.com/docs/r/x1i_kSm8n8WIoB0Vo0nN5Q/B4VySCEcbyGDA~9~YBTjCg (Work order
  states, Zurich, 2025-07-31).
- N17: https://www.servicenow.com/docs/r/api-reference/rest-apis/work-order-mgmt-api.html (Brazil).
- N18: https://www.servicenow.com/docs/bundle/zurich-field-service-management/page/product/planning-and-policy/task/t_CloseAWorkOrderTaskAsIncomplete.html
  (Zurich, 2025-07-31).
- N19: https://www.servicenow.com/docs/r/OxLLTMwXG2tKQ2SIp7HnZg/EAsQMXHubFIocnQO0na9bg (Australia,
  2026-03-12).
- N20: `node_modules/@servicenow/sdk-core/src/fluent/tables/task.now.ts` (sdk-core 4.14.0).
- N21: https://www.servicenow.com/docs/r/api-reference/rest-apis/c_TableAPI.html (Brazil, 2026-09-10).
- N22: https://www.servicenow.com/docs/r/yN_QmjTF0~igG0fSGkXXng/Oz43ezu8Fgg5NYK89lDi4A (Create a work
  order, Xanadu, 2024-08-01).
- N23: `node_modules/@servicenow/sdk-core/src/fluent/tables/cmdb_ci.now.ts:676-681,751-754`
- N24: https://www.servicenow.com/docs/r/api-reference/server-api-reference/IdentificationEngineScopedAPI.html
  (Brazil, 2026-09-10).
- N25: https://www.servicenow.com/docs/r/yokohama/api-reference/server-api-reference/c_GlideSysAttachmentScopedAPI.html
  (Yokohama, 2025-01-30).
- N26: `node_modules/@servicenow/glide/src/types/GlideSysAttachment.d.ts`
- N27: https://www.servicenow.com/docs/r/yokohama/api-reference/rest-apis/c_AttachmentAPI.html
  (Yokohama, 2025-01-30).
- N28: `node_modules/@servicenow/sdk-core/src/fluent/tables/sys_attachment.now.ts`
- N29: https://www.servicenow.com/docs/r/api-reference/server-api-reference/c_ScriptableServiceRequest.html
  (Brazil, 2026-09-10).
- N30: https://www.servicenow.com/docs/r/api-reference/server-api-reference/c_GlideRecordScopedAPI.html
  (Brazil, 2026-09-10).
- N31: https://www.servicenow.com/docs/r/api-reference/server-api-reference/c_RESTMessageV2API.html
  (Brazil, 2026-09-10).
- N32: https://www.servicenow.com/docs/r/zZBaGIzc7EPkA0ySnMn5eg/6oOpLY1WSw_qV8_mg5IhHw (Xanadu,
  2024-08-01).
- N33: `node_modules/@servicenow/glide/src/sn_ws/RESTMessageV2.d.ts`
- N34: https://www.servicenow.com/docs/r/api-reference/server-api-reference/c_GlideAggregateScopedAPI.html
  (Brazil, 2026-09-10).

## Changes needed in the app

One bullet per item with verdict differs or partially. Items that match but carry optional or
recommended hardening are described in the notes of their area.

### Cisco

- **EoX batching (partially).** `adapters.ts:35`: replace `for (const batch of chunks(pids, 20)) {`
  with `for (const batch of eoxBatches(pids)) {` and add a helper that caps both the count and the
  joined length:
  `function eoxBatches(pids: readonly string[]): string[][] { const out: string[][] = []; let batch: string[] = []; for (const pid of pids) { if (batch.length === 20 || (batch.length > 0 && [...batch, pid].join(',').length > 250)) { out.push(batch); batch = [] } batch.push(pid) } if (batch.length) out.push(batch); return out }`.
  Optional pagination: change the endpoint at `oem-messages.now.ts:24` from `/EOXByProductID/1/${pids}`
  to `/EOXByProductID/${page}/${pids}`, add a variable `{ name: 'page' }`, and in `adapters.ts` request
  page 1, then repeat while
  `Number(field(json,'PaginationResponseRecord','PageIndex')) < Number(field(json,'PaginationResponseRecord','LastIndex'))`.
  The `adapters.test.ts:18-43` expectation of 2 calls for 21 PIDs still holds when the PIDs are short.
- **SN2INFO v2 summary fields (differs).** `adapters.ts:69-70`: change
  `startDate: isoDate(field(record, 'coverage_start_date')),` to
  `startDate: undefined, // SN2INFO v2 summary has no coverage start date`, and change
  `endDate: isoDate(field(record, 'coverage_end_date')) ?? isoDate(field(record, 'warranty_end_date')),`
  to
  `endDate: isoDate(field(record, 'covered_product_line_end_date')) ?? isoDate(field(record, 'coverage_end_date')) ?? isoDate(field(record, 'warranty_end_date')),`.
  `adapters.test.ts:49`: rename the fixture key `coverage_end_date: '2027-06-30'` to
  `covered_product_line_end_date: '2027-06-30'`; the expected output at line 56 stays the same.
- **SN2INFO errors on HTTP 200 (partially; optional, error body shape unverified).** In `ciscoCoverage`
  (`adapters.ts:60-61`), after `const json = call(...)`, add
  `if (json !== undefined && !Array.isArray(field(json, 'serial_numbers')) && JSON.stringify(json).includes('EXCEEDED_OUTPUT')) errors.push('coverage_by_serial: EXCEEDED_OUTPUT')`,
  so an `EXCEEDED_OUTPUT` batch stays stale instead of being stamped checked with no coverage.

### Meraki and HPE Mist

- **Meraki claim response (partially).** `claims.ts:124-126`: replace
  `const claimed = new Set(asArray(field(parseJson(response.body), 'serials')).map((s) => text(s).toUpperCase()))`
  and `const done = claimed.size === 0 || claimed.has(t.serial.toUpperCase())` with
  `const returned = field(parseJson(response.body), 'serials')`,
  `const claimed = new Set(asArray(returned).map((s) => text(s).toUpperCase()))` and
  `const done = !Array.isArray(returned) || claimed.has(t.serial.toUpperCase())`. Only a missing
  `serials` field then counts as unknown/done; an explicit `[]` counts as nothing claimed.
- **Meraki base host (partially).** Add a variable `${meraki_host}` to each function endpoint at
  `oem-messages.now.ts:52` and `:63` (e.g.
  `'https://${meraki_host}/api/v1/organizations/${org_id}/inventory/claim'`), add a string property
  `x_daas_ham.meraki.api_host` defaulting to `api.meraki.com`, and substitute it in `rest-port.ts` with
  `gs.getProperty` (not `getPropertySecured`). Whether RESTMessageV2 substitutes a variable inside the
  host part needs checking on an instance; `rest.setEndpoint()` is the fallback.
- **Mist JSI lifecycle fields (differs).** `adapters.ts:164`: change
  `.find((i) => field(i, 'eos_time') || field(i, 'eol_time'))` to
  `.find((i) => field(i, 'end_of_sale_time') || field(i, 'eos_time'))`. `adapters.ts:168`: change
  `dates: { endOfSale: isoDate(field(item, 'eos_time')), endOfLife: isoDate(field(item, 'eol_time')) }`
  to
  `dates: { endOfSale: isoDate(field(item, 'end_of_sale_time')), endOfSupport: isoDate(field(item, 'eos_time')) }`.
  Do not map `end_of_service_time` to `endOfLife`. Update the fixture at `adapters.test.ts:117` to
  `{ model: 'AP45', end_of_sale_time: 1782777600, eos_time: 1940544000 }` with the expected
  `dates: { endOfSale: '2026-06-30', endOfSupport: '2031-06-30' }` (line 122), and
  `docs/spec/p2-oem.md:10` to "`end_of_sale_time` -> end of sale, `eos_time` -> end of support".
- **Mist JSI warranty and contract fields (differs).** `adapters.ts:181`: change
  `const end = isoDate(field(item, 'warranty_end_time')) ?? isoDate(field(item, 'contract_end_time'))`
  to `const end = isoDate(field(item, 'warranty_end')) ?? isoDate(field(item, 'contract_end_date'))`.
  `adapters.ts:187`: change
  `startDate: isoDate(field(item, 'warranty_start_time')) ?? isoDate(field(item, 'contract_start_time'))`
  to `startDate: isoDate(field(item, 'warranty_start')) ?? isoDate(field(item, 'contract_start_date'))`.
  `isoDate` already handles `YYYY-MM-DD`. Optional: line 184 `covered: !!end` to
  `covered: field(item, 'has_support') === true || !!end`. Update the fixture at
  `adapters.test.ts:118` to
  `{ serial: 'A1', warranty_type: 'Standard', warranty_start: '2024-01-01', warranty_end: '2028-01-01' }`.
  Product decision, not required by the spec: Cisco coverage prefers the contract end over the
  warranty end (`adapters.ts:70`); consider `contract_end_date ?? warranty_end` here for consistency.
- **Mist claim (partially).** `claims.ts:141-148`: replace
  `if (!isSuccess(response.status)) { outcomes.push(...fail(batch, errorText(response.status, response.body))); continue }`
  / `const json = parseJson(response.body)` with `const json = parseJson(response.body)`,
  `const hasResult = ['added', 'duplicated', 'error'].some((k) => Array.isArray(field(json, k)))` and
  `if (!isSuccess(response.status) && !(response.status === 400 && hasResult)) { outcomes.push(...fail(batch, errorText(response.status, response.body))); continue }`.
  At line 152 use
  `reasons.length === errors.length ? reasons[errors.indexOf(code)] : reasons.join('; ')` (followed by
  `|| 'claim code not accepted'`). Optional: compare codes after stripping separators
  (`c.replace(/[^A-Z0-9]/gi, '').toUpperCase()`), since `magic` has no dashes.
- **Mist API host (differs).** In `oem-messages.now.ts`, change each Mist function endpoint from
  `https://api.mist.com/api/v1/...` to `https://${mist_host}/api/v1/...` (lines 112, 123, 134) and add
  a variable `{ $id: Now.ID['rm_mist_host_<m|s|claim>'], name: 'mist_host' }` to each function; line
  105 can stay as the documentation default. Add a string property `x_daas_ham.mist.api_host` (default
  `api.mist.com`, with the 12 documented hosts as choices) and substitute it in `rest-port.ts` with
  `gs.getProperty('x_daas_ham.mist.api_host', 'api.mist.com')` through a non-secret mapping next to
  `SECRETS` (`rest-port.ts:14-19,28`). Confirm on an instance that RESTMessageV2 substitutes `${}` in
  the host part (fallback `rest.setEndpoint()`). With a single host property all configured Mist orgs
  must be on the same cloud; otherwise store the host per org.

### HPE GreenLake and Fortinet

- **GreenLake add devices (differs).** `claims.ts:54`: `const GREENLAKE_ADD_BATCH = 25` to
  `const GREENLAKE_ADD_BATCH = 5` (`perCall` at line 233 follows). `claims.ts:165`: change
  `JSON.stringify({ network: batch.map((t) => ({ serialNumber: t.serial, macAddress: t.mac })) })` to
  `JSON.stringify({ network: batch.map((t) => ({ serialNumber: t.serial, macAddress: t.mac })), compute: [], storage: [] })`.
  Update the comment at `claims.ts:158` and the `claims.test.ts:94` expectation.
- **GreenLake async operations (partially).** Option A: add `headers?: Record<string,string>` to
  `HttpResponse` (`http.ts:12`), fill it in `rest-port.ts:63` from `response.getAllHeaders()`, add a
  REST function `async_status` (`GET https://global.api.greenlake.hpe.com/devices/v1/async-operations/${op_id}`),
  and mark done only on status `SUCCEEDED`. Option B (smaller): in `greenLakeSubscribe`
  (`claims.ts:180`), treat
  `asArray(field(item, 'subscription')).some((s) => text(field(s, 'id')) === t.account)` from the
  `find_device` result as done without PATCHing, so a re-run confirms the assignment.
- **GreenLake assign subscription Content-Type (differs).** `oem-messages.now.ts:171-176`: add to
  `assign_subscription`
  `headers: [{ $id: Now.ID['rm_greenlake_patch_ct'], name: 'Content-Type', value: 'application/merge-patch+json' }],`
  and regenerate `keys.ts`. The account value must be the subscription's UUID `id`, not its key.
- **FortiCloud products/list response (partially).** `adapters.ts:140`: change
  `contractNumber: text(field(asset, 'contractNumber')),` to
  `contractNumber: text(field(asArray(field(asset, 'contracts'))[0], 'contractNumber')),` (or pick the
  contract whose `terms[].endDate` equals `latest.end`). After `adapters.ts:126` add
  ``if (json !== undefined && Number(field(json, 'status') ?? 0) !== 0) { errors.push(`products_list ${serial}: ${text(field(json, 'message')) || text(field(json, 'error'))}`); continue }``.
- **FortiCloud rate limits (differs).** `oem-sync.ts:84`: change
  `const assets = staleAssets(vendor, staleBefore.getValue(), 200)` to
  `const assets = staleAssets(vendor, staleBefore.getValue(), vendor === 'fortinet' ? 90 : 200)` and,
  after processing a Fortinet batch, add `if (vendor === 'fortinet') break` (one batch of at most 90
  calls per run). Alternative: replace per-serial calls with paged `products/list`
  `{expireBefore: <far future>, pageNumber}` bulk listing.
- **FortiCloud OAuth (partially).** Test a ServiceNow ROPC OAuth profile on an instance. If it fails
  (ServiceNow requires a Client Secret, which Fortinet does not issue, and Fortinet documents only a
  JSON token body), add a token REST function (`POST https://customerapiauth.fortinet.com/api/v1/oauth/token/`
  with JSON content) and pass `Authorization: Bearer ${access_token}` as a function header variable, as
  the Meraki and Mist messages do. Optional comment at `oem-messages.now.ts:7`: "grant_type=password
  (Resource owner password credentials), token URL
  https://customerapiauth.fortinet.com/api/v1/oauth/token/ (trailing slash)".
- **FortiZTP error body (partially).** `http.ts:28`: change `... || text(field(json, 'detail'))` to
  `... || text(field(json, 'detail')) || text(field(json, 'error_description')) || text(field(json, 'error'))`.

### Check Point Zero Touch, ShipEngine and EasyPost

- **Zero Touch base URL and path (differs).** `oem-messages.now.ts:203`: endpoint
  `https://zerotouch.checkpoint.com/api/v1` to `https://zerotouch.checkpoint.com/ZeroTouch/web_api/v2`.
  Replace function `assign_gateway` (`:209-215`) with: (1) `login`: `POST .../ZeroTouch/web_api/v2/login`,
  content `'{"api-client-id":"${api_client_id}","api-key":"${api_key}"}'`, variables `api_client_id`
  and `api_key`, no auth header; (2) `claim_gateway`: `POST .../web_api/v2/claim-gateway`, header
  `{name:'X-chkp-sid', value:'${sid}'}`, variable `sid`; (3) optionally `claim_gaia_gateway`:
  `POST .../web_api/v2/claim-gaia-gateway`, same header; (4) `logout`: `POST .../web_api/v2/logout`,
  header `X-chkp-sid: ${sid}`, no body. The Fluent RestMessage function type has `content?: string`
  (`node_modules/@servicenow/sdk-core/dist/rest/RestMessage.d.ts:90`); send `login` without
  `request.body` so the content template, with the secrets substituted, is the body. Delete the comment
  at `oem-messages.now.ts:150`.
- **Zero Touch authentication (differs).** `rest-port.ts:17`: change
  `[{ variable: 'api_key', property: 'x_daas_ham.checkpoint.api_key' }]` to
  `[{ variable: 'api_client_id', property: 'x_daas_ham.checkpoint.api_client_id' }, { variable: 'api_key', property: 'x_daas_ham.checkpoint.api_key' }]`.
  In `oem-claims.now.ts` add a password2 property `x_daas_ham.checkpoint.api_client_id` ("Check Point
  Zero Touch API Client ID") and reword `prop_checkpoint_key`'s description to "Check Point Zero Touch
  API Key (expires after 1-180 days; regenerate in Zero Touch portal > Manage API Key)". Remove the
  `X-API-Key` header (`oem-messages.now.ts:214`) and send `X-chkp-sid: ${sid}` from the login response.
- **Zero Touch claim body (differs).** `claims.ts:222-226`: replace the `perDevice` adapter with a
  session adapter that runs `unusable(targets,'mac')`; returns calls 0 when `maxCalls < 3`; calls
  `login = http({fn:'login', params:{}})` and reads `sid = text(field(parseJson(login.body),'sid'))`;
  if `sid` is empty, fails the usable targets with `errorText(login.status, login.body)`; otherwise,
  while `calls < maxCalls - 1`, parses `[accountId, templateId] = t.account.split('/')` (refusing
  non-numeric values) and calls
  `http({ fn: 'claim_gateway', params: { sid }, body: JSON.stringify({ 'object-name': t.serial, 'account-id': Number(accountId), 'template-id': Number(templateId), mac: t.mac }) })`
  with ``outcome(..., `claimed with Zero Touch template ${templateId}`)``; ends with
  `http({ fn: 'logout', params: { sid } })`, counting login and logout in `calls`. `staging.now.ts:156`:
  label "Check Point Zero Touch (template)" to "Check Point Zero Touch (User Center account id/template
  id)". Update `claims.test.ts:151-157`. If `CPAP-SG3600` (`demo-seed.ts:84`) is a Gaia appliance, it
  needs `claim-gaia-gateway`, so pick the command by model family.
- **ShipEngine carrier_id (differs).** `domain/shipping.ts:24-31`: add `carrierId: string` to
  `LabelInput`. `domain/shipping.ts:88-89`: `shipment: { service_code: input.serviceCode,` to
  `shipment: { carrier_id: input.carrierId, service_code: input.serviceCode,`. `shipping.now.ts`: add
  property `x_daas_ham.shipping.carrier_id` (string, value `''`, description "ShipEngine carrier account
  id (se-...) billed for labels"). `properties.ts`: add
  `shippingCarrierId: 'x_daas_ham.shipping.carrier_id'`. `entry/shipping.ts:80-87`: pass
  `carrierId: stringProperty(PROPERTY.shippingCarrierId)` to `buyLabel` and refuse with a clear error
  when it is empty. Update `shipping.test.ts`.
- **ShipEngine addresses (partially).** `domain/shipping.ts:64-76`: drop empty values instead of
  sending `''` (e.g. `return Object.fromEntries(Object.entries({...}).filter(([, v]) => v !== ''))`).
  `domain/shipping.ts:99-103` `buyLabel`: require the from-side phone, e.g.
  `if (!input.from.phone) return { ok: false, error: 'from address missing phone' }`. Consider
  requiring state for US and CA addresses.
- **ShipEngine webhook auth (partially).** `entry/shipping.ts:146`: change
  `const token = queryParam(request, 'token')` to
  `const token = request.getHeader('x-naas-webhook-token') || queryParam(request, 'token')`
  (`RESTAPIRequest.getHeader` is in `node_modules/@servicenow/glide/src/sn_ws_int/RESTAPIRequest.d.ts:12`).
  Register the ShipEngine webhook with `headers: [{ key: 'X-NaaS-Webhook-Token', value: <token> }]` and
  update the comments at `shipping.now.ts:9` and `rest.now.ts:182`. Keep `?token=` only as a fallback.
  Optionally verify the RSA-SHA256 signature against `request.body.dataString`.
- **EasyPost Event envelope (partially).** `domain/shipping.ts:201-203`: after
  `const easyPost = field(body, 'result')`, add
  ``const kind = text(field(easyPost, 'object')); if (kind && kind !== 'Tracker') return { error: `not a tracking update (${kind})` }``.
  Equivalently, require `text(field(body,'description')).startsWith('tracker.')` when `description` is
  present. Existing tests without `object`/`description` still pass.
- **EasyPost tracking_details order (partially).** `domain/shipping.ts:206`: replace
  `const last = details[details.length - 1]` with a pick of the detail with the greatest
  `Date.parse(text(field(d,'datetime')))`; datetimes can carry a local offset.
- **EasyPost webhook auth (partially).** Same header fallback as ShipEngine at `entry/shipping.ts:146`.
  Register the EasyPost webhook with `custom_headers: [{ name: 'X-NaaS-Webhook-Token', value: <token> }]`
  (not `X-EasyPost-*`). Optionally verify `X-Hmac-Signature` with `webhook_secret` against
  `request.body.dataString`.
- **ShipEngine webhook delivery and retries (differs).** `entry/shipping.ts` `postTrackingUpdate`: when
  the Shipment's tracking lock stays held, answer 2xx at once and apply the update in the background
  (an event whose script action takes the same lock and queues itself again a minute later, a bounded
  number of times), keeping 503 only for an update that cannot be queued. Applied on 2026-11-07: HTTP
  202 and the event `x_daas_ham.shipment.track`.

### ServiceNow platform

- **Substatus choices shipped (differs).** Both changes are needed: (1) `now.config.json`: add
  `"legacyChoices": false`; (2) `substatus-choices.now.ts`: add one parent record
  `Record({ $id: Now.ID['substatus_choice_set'], table: 'sys_choice_set', data: { name: 'alm_asset', element: 'substatus' } })`.
  A scratch build with both changes produced one `author_elective_update/sys_choice_alm_asset_substatus.xml`
  with a `sys_choice_v2 version="4"` wrapper, all 12 choices, and a `delete_multiple` that only matches
  those 12 (name, element, value, language, dependent_value) identities. Do not add the parent while
  `legacyChoices` is true: the v3 output would wipe the out-of-box substatus choices. Requires Brazil,
  Australia P4+ or Zurich P11+. Then add a check that the built XML contains every `ADDED_SUBSTATUSES`
  value.
- **Substatus collisions (differs).** On the instance, query `sys_choice`
  `name=alm_asset^element=substatus^dependent_value=6`. If the out-of-box value is
  `pending_evaluation`, delete it from `ADDED_SUBSTATUSES` (`lifecycle.ts:68`) and its Record
  (`substatus-choices.now.ts:115-128`); the `STAGE_FIELDS` mapping can stay. If the value differs, set
  `STAGE_FIELDS.pending_evaluation.substatus` (`lifecycle.ts:40`) to it and drop the added choice.
  Optional: map `returned_to_lessor` (`lifecycle.ts:49`) to the out-of-box "Lease return" value once
  that value is confirmed.
- **Out-of-box substatus values (partially).** No code change proposed; confirm the stored values
  other than `available` on an instance.
- **`alm_asset.cost` currency (partially).** Only needed if the session currency can differ from the
  billing currency. `leases.ts:225`: `asset.setValue('cost', share)` to
  ``asset.setValue('cost', `${currencyCode};${share}`)`` using the lease's currency. `margin.ts:86`:
  `purchaseCost: num(asset, 'cost')` to
  `purchaseCost: Number(asset.getElement('cost').getReferenceValue()) || 0`, or `getCurrencyValue()`
  with `getCurrencyCode()`.
- **`proc_po` (partially).** `procurement.ts:17`: replace
  `if (input.shipToStockroomId) po.setValue('ship_to', ...)` with an early
  `if (!input.shipToStockroomId) { gs.warn('[x_daas_ham] No staging stockroom: purchase not requested'); return '' }`
  followed by an unconditional `setValue`. Confirm the column names (`status`, `ship_to`,
  `short_description`) and the `requested` value on the instance.
- **`proc_po_item` open quantity (partially).** `procurement.ts:35`: add
  `item.addQuery('status', 'NOT IN', 'received,canceled,cancelled')` beside the `purchase_order.status`
  filter, so a line canceled on its own under an open PO no longer counts as open. Confirm the stored
  choice values on the instance.
- **`wm_order` fields (partially).** No code change proposed; confirm the column names behind
  "Scheduled start" and "Estimated end" on an instance.
- **`cmdb_ci.discovery_source` (partially).** No code change proposed; confirm that ServiceNow
  Discovery writes `ServiceNow` on an instance.

## Still needs an instance or vendor login

Items with verdict unverifiable:

- **Cisco rate limits and quotas.** Per-app quotas are visible only after logging in to the Cisco API
  Console.
- **Meraki coverage via SN2INFO.** No primary source confirms that Meraki devices are in the SN2INFO
  install base or contract data.
- **FortiCloud products/register request schema.** Only on FNDN (login). The per-unit `description`
  field is unconfirmed. If the API user is Org-scoped, add `accountId` at `claims.ts:200`:
  `JSON.stringify({ accountId: Number(<provider FortiCloud account id property>), registrationUnits: ... })`.
  Check the schema on FNDN before enabling.
- **FortiZTP provision.** Only on FNDN (login). Suggested change, to confirm there first:
  `oem-messages.now.ts:183` `https://fortiztp.forticloud.com/public/api/v1` to
  `https://fortiztp.forticloud.com/public/api/v2`; `oem-messages.now.ts:194`
  `.../public/api/v1/devices/${serial}` to
  `https://fortiztp.forticloud.com/public/api/v2/devices/${serial}`; `claims.ts:217` body to
  `{ deviceSN: t.serial, deviceType: 'FortiGate', provisionStatus: 'provisioned', provisionTarget: 'FortiManager', fortiManagerOid: Number(t.account) }`,
  settling a non-integer account as failed ("FortiManager OID must be a number"); change the
  `claims.test.ts:130-136` fixture account `FMG-1` to a numeric OID.
- **FortiZTP client_id.** Read it from the API user's credentials ZIP (normally `fortiztp` per the
  third-party SDKs).
- **`wm_order` state 3 = Closed Complete.** Only community posts give the number.
- **`GlideAggregate.groupBy` on date fields.** The format of a grouped `glide_date` key is not
  documented.
- **`setWorkflow(false)` on `alm_hardware` from `x_daas_ham`.** Test with an ATF step that calls the
  device-events API as a scoped role user. If it is ignored, grant the API's callers a role whose
  visibility scope is "everything", or add a bypass condition to the `alm_hardware` before-query rule.

Other open points raised in the findings:

- Cisco: how Cisco's path parsing handles PIDs containing `/` (e.g. `CISCO2901/K9`), which
  `rest-port.ts:27` sends as `%2F`; some servers reject encoded slashes.
- Cisco: whether SN2INFO `service_contract_number` can hold several comma-separated numbers (the field
  description's example reads "1234567, 2345678, 3456789"; every sample shows one number).
- Cisco: the JSON shape of SN2INFO error bodies returned with HTTP 200.
- Cisco: the exact ServiceNow setting for sending client credentials (request body or Basic header);
  Cisco documents body parameters.
- Cisco: whether a reinstall clears an OAuth profile set on the instance (`oauthProfile` is unset in
  code).
- Cisco: whether the SN2INFO reference page's 404 signals a retirement; confirm with a live call before
  enabling coverage sync.
- Meraki and Mist: the batch sizes (50 Meraki serials, 100 Mist codes) are not documented.
- Meraki and Mist: whether RESTMessageV2 substitutes `${}` variables in the host part of an endpoint.
- GreenLake: whether RESTMessageV2 accepts the unencoded spaces and quotes in the `find_device` filter
  URL.
- Fortinet: whether a ServiceNow ROPC OAuth profile works without a client secret and with Fortinet's
  JSON token body, for both FortiCare and FortiZTP.
- ShipEngine: whether it enforces `state_province` for countries without states (e.g. NL).
- ShipEngine: whether labels bought through ShipEngine are subscribed to `track` webhooks
  automatically or need `/v1/tracking/start`.
- EasyPost: whether a `?token=` query string in the webhook URL is kept.
- Check Point: whether the demo model `CPAP-SG3600` is a Gaia or a Quantum Spark appliance.
- ServiceNow: whether the instance accepts the app owning the `alm_asset.substatus` choice set.
- ServiceNow: the `proc_po` and `proc_po_item` column names and stored status values.
- Not checked by any researcher: the `cmn_location` fields used by `addressOf` (street, city, state,
  zip, country, phone).
