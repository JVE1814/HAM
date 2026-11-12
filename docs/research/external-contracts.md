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
The note names a file of the app, not a line in it: a line number goes stale with the next edit.
Each file is named by the path it has now, so the code a row cites is found by the names the row
quotes. The only line numbers left are in the SDK packages, at the versions named above.

The findings are of the research date. "Changes needed in the app" quotes the code as it stood then,
and those changes have since been applied (see the status below), so a line it quotes may read
differently now.

Verdicts: **matches** (the app agrees with the source), **partially** (the core contract agrees,
but a limit, edge case or secondary field does not), **differs** (the app contradicts the source),
**unverifiable** (no reachable primary source settles it).

How the paths below are shortened:

| Path as written | Under |
|---|---|
| `domain/...`, `platform/...`, `entry/...` | `src/server/` |
| `oem/...`, `delivery/...`, `fleet/...`, `racks/...`, `break-fix/...`, `shared/...` | `src/fluent/` |
| `alm_asset.now.ts`, `choice-set-plugin.ts`, `choice-set-utils.ts`, `RestMessage.d.ts` | the SDK packages in `node_modules` |

The vendor sync adapters are in `domain/oem/sync-adapters.ts` and the vendor claim adapters in
`domain/oem/claim-adapters.ts`. `domain/oem/adapters.ts` routes each vendor to its adapters.


**Status (2026-11-07):** every change under "Changes needed in the app" has been applied, except the
optional EoX pagination and SN2INFO `EXCEEDED_OUTPUT` handling (a batch that always errors would block
the queue) and the speculative FortiZTP v2 / FortiCloud `accountId` changes, which wait for an FNDN
check. What still needs an instance or a vendor login is listed in
[verify-on-instance.md](../verify-on-instance.md).

## Cisco Support APIs

| Item | App assumes | Source says | Verdict | Source |
|---|---|---|---|---|
| EoX v5 by PID: host, method, path, encoding | `GET https://apix.cisco.com/supporttools/eox/rest/5/EOXByProductID/1/${pids}?responseencoding=json`, PIDs comma-joined (`oem/rest-messages.now.ts`) | URI `.../EOXByProductID/{pageIndex}/{productID}`; sample request has the same form | matches | C1 |
| EoX batching | 20 PIDs per call, page 1 only (`domain/oem/sync-adapters.ts`) | 20 PIDs max, but `productID` is limited to 250 characters; 50 records per page | partially | C1 |
| EoX response mapping | `EOXRecord`, skip on `EOXError`, `EOLProductID`, `EndOfSaleDate.value`, `LastDateOfSupport.value` for support and life, `LinkToProductBulletinURL` (`domain/oem/sync-adapters.ts`) | All fields exist; dates are `{value, dateFormat}`; LDoS definition supports support = life | matches | C1 |
| SN2INFO v2 coverage summary: path and doc status | `GET https://apix.cisco.com/sn2info/v2/coverage/summary/serial_numbers/${serials}` (`oem/rest-messages.now.ts`) | Same path; the DevNet reference page now returns 404 | matches | C2, C3, C4, C5 |
| SN2INFO batch size | 50 serials per call, page 1 only (`domain/oem/sync-adapters.ts`) | Up to 75 serials (40 characters each); 50 records per page | matches | C2, C6 |
| SN2INFO v2 summary response fields | `coverage_start_date`, `coverage_end_date` then `warranty_end_date` (`domain/oem/sync-adapters.ts`) | v2 summary has no `coverage_start_date` or `coverage_end_date`; contract end is `covered_product_line_end_date` | differs | C2, C6 |
| SN2INFO errors on HTTP 200 | Only non-2xx and non-JSON count as errors (`domain/oem/sync-adapters.ts`) | `NO_RECORDS_FOUND` and `EXCEEDED_OUTPUT` arrive with HTTP 200; body shape undocumented | partially | C2 |
| Service Order Return (RMA) v1.0 by RMA number | `GET https://apix.cisco.com/return/v1.0/returns/rma_numbers/${rma}`; reads `returns.RmaRecord[]` (`oem/rest-messages.now.ts`, `domain/oem/sync-adapters.ts`) | Same path; one RMA per call; `status` is open, booked, hold, cancelled or closed | matches | C7 |
| OAuth 2.0 client credentials | `oauth2` with a profile attached on the instance (id.cisco.com); no `oauthProfile` in code | Token from `https://id.cisco.com/oauth2/default/v1/token`, client credentials grant, 1-hour tokens | matches | C8, C9, C5, C10, C11 |
| SNTC/PSS entitlement | Required (`oem/rest-messages.now.ts`, `docs/spec/p2-oem.md`) | APIs are available only to SNTC customers and PSS partners | matches | C12, C9, C2 |
| Rate limits and quotas | No throttling in the Cisco adapters | No numeric limit published; quotas visible only in the API Console | unverifiable | C9, C1, C7 |
| Meraki coverage via SN2INFO | Meraki serials go to SN2INFO (`domain/oem/adapters.ts`) | SN2INFO reference does not mention Meraki | unverifiable | C2 |

Notes:

- **EoX path.** `pageIndex` is optional (integer, length 5, "a maximum of 50 records per page are
  returned"). `productID` is required (string, length 250, "Enter up to 20 PIDs separated by
  commas"). Wildcards are allowed with at least 3 characters. `responseencoding` is optional, `xml`
  or `json`. The sample request is exactly
  `GET https://apix.cisco.com/supporttools/eox/rest/5/EOXByProductID/1/WIC-1T=?responseencoding=json`.
  `platform/rest-messages.ts` URL-encodes each value and puts the commas back.
- **EoX batching.** The 20-PID limit is confirmed by error `SSA_ERR_009` ("The number of product IDs
  exceeds 20."). The app does not enforce the 250-character limit: twenty typical PIDs such as
  `WS-C3850-48P-L` (14 characters) plus commas come to about 299 characters.
  `PaginationResponseRecord` (`PageIndex`, `LastIndex`, `TotalRecords`, `PageRecords`) is never read.
  "You can receive multiple EoX records for the same PID if that product includes multiple migration
  paths", so 20 PIDs can exceed one page. `docs/spec/p2-oem.md` says "EoX v5 by PID, 20 per call".
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
  limits. `docs/spec/p2-oem.md` says "SN2INFO v2, 50 per call".
- **SN2INFO summary fields.** The v2 summary response parameters are `base_pid`,
  `contract_site_address1`, `contract_site_city`, `contract_site_country`,
  `contract_site_customer_name`, `contract_site_state_province`, `covered_product_line_end_date`
  (date, "End date of the covered product line in the following format: YYYY-MM-DD"), `id`,
  `is_covered` ("YES or NO"), `item_description`, `item_position`, `item_type`, `last_index`,
  `orderable_pid`, `page_index`, `page_records`, `parent_sr_no`, `pillar_code`, `self_link`,
  `service_contract_number` (string 200), `service_line_descr` (e.g. "SMARTnet Premium 24x7x4"),
  `sr_no`, `title`, `total_records`, `warranty_end_date` (YYYY-MM-DD), `warranty_type` and
  `warranty_type_description`. `coverage_end_date` belongs to the v1.0 summary and to the v2
  `coverage/status` and `owner_status` methods; neither version has `coverage_start_date`. Against
  v2 the app never reads the contract end date, always falls back to `warranty_end_date`, and
  `startDate` is always undefined. The test fixture at `domain/oem/adapters.test.ts` uses
  `coverage_end_date`.
- **SN2INFO error table.** `200 NO_RECORDS_FOUND` ("No records found."), `200 EXCEEDED_OUTPUT`
  ("Server error; too many results."), `400 API_MISSING_PARAMETERS`, `API_INVALID_INPUT`,
  `EXCEEDED_INPUTS`, `403 API_NOTAUTHORIZED`, `500 API_ERROR_01`. Today a 2xx body without
  `serial_numbers` yields no facts and no errors, and `platform/coverage.ts` then stamps every
  serial in the batch as checked.
- **RMA.** Sample request `GET https://apix.cisco.com/return/v1.0/returns/rma_numbers/84894022` with
  `Authorization: Bearer ...`. `rma_numbers` is required, int, length 10: "Currently, only one RMA
  Number is required and accepted." Response:
  `{APIPagination{...}, returns{RmaRecord:[{rmaNo, status, orderDate, caseId, ..., contractId, serviceLevel, customerRefInfo, shipToInfo, billToInfo, replacementParts, returnLines, laborDetails, notes}]}}`.
  Status casing varies between samples ("Booked", "BOOKED", "HOLD"); the app stores the raw string
  in `x_daas_ham_oem_rma.status` (StringColumn, 100 characters; `platform/oem-rma.ts`,
  `break-fix/break-fix.now.ts`). `rmaNo` is typed string but the sample returns a JSON number;
  `text()` handles numbers. The parameter table calls `returns` an "array", but this doc uses
  "array" loosely for objects and the sample shows an object. "If a space is encountered in a
  mandatory input parameter, Error 403 is thrown." Error codes: `API_RMA_FORMAT_ERROR`,
  `API_DATEFORMAT_ERROR`, `SVO_NO_RECORDS`.
- **RMA, optional hardening (verdict matches).** (1) `domain/oem/sync-adapters.ts`: use
  `asArray(field(json, 'returns')).flatMap((r) => asArray(field(r, 'RmaRecord')))` so `returns` as
  an array is tolerated. (2) `domain/oem/sync-adapters.ts`: key the fact by the requested number
  (`const rmaNumber = rma`), so the lookup at `platform/oem-rma.ts` (`records.get(fact.rmaNumber)`)
  cannot miss when a numeric `rmaNo` serializes differently. (3) `platform/oem-rma.ts`: use
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
- **Rate limits.** The app sends one lifecycle call per 20 PIDs daily
  (`domain/oem/sync-adapters.ts`), one coverage call per 50 serials time-boxed by
  `x_daas_ham.job.budget_seconds` (`platform/oem-sync.ts`), and one RMA call per open RMA hourly, up
  to 200 (`platform/oem-rma.ts`). No numeric limit appears on the EoX, SN2INFO, RMA, authentication
  or registration pages; the API Console "Keys" view shows "API usage and request quota reports"
  after login.
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
| Meraki inventory devices: path, `models[]`, `-HW`, paging | `GET https://api.meraki.com/api/v1/organizations/${org_id}/inventory/devices?models[]=${model}`; `-HW` stripped; first page; first device with `eox` (`oem/rest-messages.now.ts`, `domain/oem/sync-adapters.ts`) | Path and `models` array filter match; official SDK sends `models[]`; example `MR34` / sku `MR34-HW`; paging via `Link` header | matches | M1, M2, M3 |
| Meraki EoX field names | `eox.endOfSaleAt`, `eox.endOfSupportAt` (`domain/oem/sync-adapters.ts`) | `eox {status, endOfSaleAt, endOfSupportAt}`, date-time strings; no `eoxStatus` field | matches | M1, M2 |
| Meraki API key header | `Authorization: Bearer ${api_key}` (`oem/rest-messages.now.ts`) | v1 supports Bearer; `X-Cisco-Meraki-API-Key` is the v0 header | matches | M4, M5, M1, M6 |
| Meraki claim into inventory | `POST .../inventory/claim` `{"serials":[...]}`, 50 per call; empty response `serials` means all done (`domain/oem/claim-adapters.ts`) | Body and response field names match; response `serials` lists the serials actually claimed; no per-call maximum | partially | M1, M7, M8, M3 |
| Meraki claim rate limit | 10 calls per 5 minutes; budget 8 per 5-minute run (`oem/logic.now.ts`) | "up to ten times within a single five minute window"; scope and window type not stated | matches | M7, M1, M9, M8 |
| Meraki API base host | `https://api.meraki.com/api/v1` hard-coded (`oem/rest-messages.now.ts`) | Right "in most parts of the world"; Canada, China, India and FedRAMP use other hosts | partially | M5, M10 |
| Mist JSI inventory: path, filters, paging | `GET https://api.mist.com/api/v1/orgs/${org_id}/jsi/inventory?model=` or `?serial=`; page 1 (`oem/rest-messages.now.ts`) | Same path; `model`, `serial`, `limit` (default 100), `page`; 200 body is a JSON array | matches | H1, H2 |
| Mist JSI lifecycle fields | `eos_time` = end of sale, `eol_time` = end of life (`domain/oem/sync-adapters.ts`) | `end_of_sale_time` = end of sale; `eos_time` = end of support; no `eol_time` | differs | H1 |
| Mist JSI warranty and contract fields | `warranty_start_time`, `warranty_end_time`, `contract_start_time`, `contract_end_time` (`domain/oem/sync-adapters.ts`) | None exist; fields are `warranty_start`, `warranty_end`, `contract_start_date`, `contract_end_date` | differs | H1 |
| Mist claim into inventory | `POST .../orgs/${org_id}/inventory`, bare array of codes, 100 per call; non-2xx fails batch; reasons by position (`domain/oem/claim-adapters.ts`) | Body and field names match; a 400 carries the same per-code result; `reason[]` not documented as parallel to `error[]` | partially | H1 |
| Mist auth header | `Authorization: Token ${api_token}` (`oem/rest-messages.now.ts`) | Same format | matches | H1, H3 |
| Mist rate limits | No explicit assumption; claims about 96 calls per hour | 5,000 calls per hour per token | matches | H3, H1, H4 |
| Mist API host | `https://api.mist.com` for every org (`oem/rest-messages.now.ts`) | Global 01 only; 11 other regional hosts | differs | H5, H1 |

Notes:

- **Meraki inventory.** `GET /organizations/{organizationId}/inventory/devices` returns a JSON array.
  Query parameters: `perPage` ("Acceptable range is 3 - 1000. Default is 1000."), `startingAfter` and
  `endingBefore` (tokens that should come from the `Link` header), `usedState`, `search`, and the
  arrays `macs`, `networkIds`, `serials`, `models` ("Search for devices in inventory based on
  model."), `orderNumbers`, `tags`, `tagsFilterType`, `productTypes`, `eoxStatuses`. The official
  Python SDK sends array parameters with a `[]` suffix (`params['models[]']`). The spec does not say
  whether `eox` is left out for devices without EoX data; `eox.status` is nullable. Reading only the
  first page is fine for a model lookup (up to 1000 rows by default).
- **Meraki inventory, optional hardening (verdict matches).** In `domain/oem/sync-adapters.ts`,
  replace `asArray(json).find((d) => field(d, 'eox'))` with
  `asArray(json).find((d) => field(d, 'eox', 'endOfSaleAt') || field(d, 'eox', 'endOfSupportAt'))`.
  Otherwise an `eox` object with a null status and no dates is recorded as a fact with no dates, and
  the `break` after it stops the search in the remaining orgs. Optionally append `&perPage=3` (the
  documented minimum) at `oem/rest-messages.now.ts`. Done: `domain/oem/sync-adapters.ts`
  `hasEoxDates`.
- **Meraki EoX fields.** `status` is a nullable string with enum `endOfSale`, `endOfSupport`,
  `nearEndOfSupport`. `endOfSaleAt` ("End of sale date for the device product") and `endOfSupportAt`
  are date-time strings. Example: `"eox": {"status":"endOfSale","endOfSaleAt":"2031-07-29T02:00:00Z",
  "endOfSupportAt":"2032-07-29T02:00:00Z"}`. The filter query parameter is `eoxStatuses` (array;
  `endOfSale`, `endOfSupport`, `nearEndOfSupport` or `null`). A separate
  `GET /organizations/{organizationId}/inventory/devices/eox/overview` returns counts only. The test
  fixture (`domain/oem/adapters.test.ts`) uses the same shape.
- **Meraki auth.** Authorization page: "Dashboard API v1 supports Bearer Auth using the standard
  Authorization header parameter", example `Authorization: Bearer {API_KEY}`; it calls
  `X-Cisco-Meraki-API-Key` "v0's" header. Getting Started: "requires a bearer token". The v1 OpenAPI
  still lists both schemes (`meraki_api_key` and `bearerAuth`). The official SDK sends
  `'Authorization: Bearer ' + api_key`. The key comes from the password2 property
  `x_daas_ham.meraki.api_key` (`platform/rest-messages.ts`).
- **Meraki claim.** operationId `claimIntoOrganizationInventory`. The request body is optional, with
  `orders` (string[]), `serials` (string[], "The serials of the devices that should be claimed") and
  `licenses` (`[{key (required), mode addDevices or renew}]`). The 200 response has `orders`,
  `serials` ("The serials of the devices claimed") and `licenses`. Error body format is
  `{"errors": ["..."]}`, so `errorText`'s `errors[0]` matches. OAuth scope, if OAuth is used:
  `dashboard:licensing:config:write`. The 50-serial batch size (`MERAKI_CLAIM_BATCH`,
  `domain/oem/claim-adapters.ts`) is not documented.
- **Meraki rate limits.** The Rate Limit page gives up to 10 requests per second per organization
  (burst of 10 more in the first second; shared by all apps using the org) and up to 100 requests per
  second per source IP; over the limit the API returns 429 with `Retry-After`. The Errors page:
  429 means "Too many requests... We recommend an exponential backoff". The docs do not say whether
  the claim window is per IP, per org or per key, or whether it is fixed or sliding, so the "per IP"
  scope should not be stated. A 429 today fails the batch and uses one of its `MAX_CLAIM_ATTEMPTS`
  (`domain/oem/claims.ts`).
- **Meraki claim, recommended (not a contract mismatch).** (1) In `domain/oem/claim-adapters.ts`
  `merakiClaim`, and in `mistClaim` the same way, add `if (response.status === 429) break` before
  the `!isSuccess` branch, so the batch is left for the next run instead of using an attempt. (2)
  Two adjacent 5-minute runs can fall in one sliding window (8 + 8 > 10). To guarantee the
  documented limit, cap Meraki at 5 per run, e.g. `Math.min(maxCalls, 5)` in `runVendorClaims` when
  `vendor === 'meraki'` (`max_calls` is shared by all vendors), or change `oem/logic.now.ts`
  `value: 8` to `value: 5`.
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
  (`domain/oem/sync-adapters.ts`) and sends the raw PID as `model` (`domain/oem/sync-adapters.ts`).
- **Mist JSI, operational caveats (verdict matches).** JSI needs a Juniper support account linked to
  the Mist org; otherwise the call returns 400 "no juniper account linked", which shows as
  "HTTP 400" in the errors list. The `model` filter matches the JSI `model` value (e.g.
  `EX2300-24MP`, `AP43`), not the `sku`, so a PID stored as an ordering SKU may not match;
  `/jsi/inventory/search` has a `sku` filter if needed.
- **Mist lifecycle fields.** `js_inventory_item`: `end_of_sale_time` (integer, "End of sale epoch
  timestamp"), `eos_time` (integer, "End of support time"), `end_of_service_time` (integer, "End of
  service epoch timestamp"), `version_eos_time` (software), `eol_psn` (product support notice for
  the end-of-life milestone). `eol_time` has 0 occurrences in the spec. Example: `end_of_sale_time`
  1561507200, `end_of_service_time` 1661507200, `eos_time` 1672012800. The meaning of
  `end_of_service_time` is not defined, and in the example it is earlier than `eos_time`. Today Mist
  lifecycle records the wrong date as end of sale and never records end of support, so
  refresh-by-support (`domain/model-lifecycle.ts` uses `endOfSupport`) gets no Mist data. The test
  fixture (`domain/oem/adapters.test.ts`) and `docs/spec/p2-oem.md` carry the same names.
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
  API Token used for the request reached the 5000 API Calls per hour threshold". "Rate limiting is
  done on an individual token basis". Older mist.com page (2018): "reset at the hourly boundary".
  Recommended: treat 429 as "stop this run" (`if (response.status === 429) break` in `mistClaim`
  before `domain/oem/claim-adapters.ts`). Optional: batch serials and models comma-separated to cut
  lookup calls.
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
| GreenLake base URL and API version | `https://global.api.greenlake.hpe.com`, `/devices/v1/...` (`oem/rest-messages.now.ts`) | Same host; v1 is stable; v1beta1 stopped working 2025-05-05; v2beta1 is beta | matches | G1, G2, G3 |
| GreenLake add devices | `POST /devices/v1/devices`, 25 per call, `{"network":[...]}` only (`domain/oem/claim-adapters.ts`) | Max 5 devices per request; `compute`, `network` and `storage` all required | differs | G2, G1, G3 |
| GreenLake add and update are asynchronous | Any 2xx = done; response headers not exposed (`domain/oem/claim-adapters.ts`, `domain/http.ts`, `platform/rest-messages.ts`) | 202 means input validated; progress at the `Location` URL (`/devices/v1/async-operations/{id}`) | partially | G2, G1 |
| GreenLake find device | `GET .../devices/v1/devices?filter=serialNumber eq '${serial}'`, reads `items[0].id` (`oem/rest-messages.now.ts`, `domain/oem/claim-adapters.ts`) | Same filter syntax and response fields | matches | G2, G1 |
| GreenLake assign subscription | `PATCH .../devices/v1/devices?id=${device_id}`, `{"subscription":[{"id"}]}`, inherits `Content-Type: application/json` (`oem/rest-messages.now.ts`) | Request body accepts only `application/merge-patch+json` | differs | G2, G3, G4 |
| GreenLake authentication | `oauth2` with a profile attached on the instance (`oem/rest-messages.now.ts`) | Client credentials grant; per-workspace token URL; tokens valid 15 minutes | matches | G5, G6, G7 |
| FortiCloud Asset Management v3: base URL, products/list | `POST https://support.fortinet.com/ES/api/registration/v3/products/list` `{"serialNumber"}`, one call per serial (`oem/rest-messages.now.ts`) | Same base and resource; `serialNumber` or `expireBefore` required in the body | matches | F1, F2 |
| FortiCloud products/list response | `assets[].entitlements[]`, `asset.contractNumber`; API `status` ignored (`domain/oem/sync-adapters.ts`) | `contractNumber` sits under `assets[].contracts[]`; `status` 0 means success | partially | F1, F3 |
| FortiCloud rate limits vs coverage sync | 200 serials per batch, one call each, looping up to 120 s (`platform/oem-sync.ts`) | 100 calls per minute, 1000 per hour, 10 errors per hour | differs | F1 |
| FortiCloud products/register | 10 per batch, `{"registrationUnits":[{serialNumber, description, isGovernment}]}`, no `accountId` (`domain/oem/claim-adapters.ts`) | 10 per batch confirmed; request schema only on FNDN (login) | unverifiable | F1, F3, F4, F2 |
| FortiCloud OAuth | `oauth2` profile; IAM API user with client_id `assetmanagement` (`oem/rest-messages.now.ts`) | Password grant at `customerapiauth.fortinet.com`, JSON body; client_id matches; no client secret issued | partially | F5, F1, G7 |
| FortiZTP provision to FortiManager | `PUT https://fortiztp.forticloud.com/public/api/v1/devices/${serial}`, `fortiManagerOid` as a string, no `deviceSN` (`oem/rest-messages.now.ts`, `domain/oem/claim-adapters.ts`) | Primary reference needs login; third-party SDKs suggest a v1/v2 mix | unverifiable | F6, F7, F8, F9, F10 |
| FortiZTP client_id | Not stated in code or docs (`oem/rest-messages.now.ts`) | From the credentials ZIP; official examples omit FortiZTP; SDKs use `fortiztp` | unverifiable | F5, F9, F10 |
| FortiZTP and FortiCloud error body | `errorText` reads `errors[0]`, `message`, `detail` (`domain/http.ts`) | `{"error", "error_description"}` | partially | F9, F5 |

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
  (`domain/oem/claim-adapters.ts`).
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
- **GreenLake find device, optional hardening (verdict matches, unverified without an instance).**
  The endpoint holds raw spaces and quotes, which RFC 3986 requires to be percent-encoded. If
  RESTMessageV2 rejects or mangles the URL, change `oem/rest-messages.now.ts` to
  `"https://global.api.greenlake.hpe.com/devices/v1/devices?filter=serialNumber%20eq%20%27${serial}%27"`.
- **GreenLake assign subscription.** operationId `patchDevicesV1`; query parameter `id` (required;
  array of uuid, style form, explode true; "Maximum five devices per request"). Body schema:
  `subscription[]` items `{id (required, string)}`, `application {id}`, `region`,
  `tenantPlatformCustomerId`. "Only one operation is supported in a single API call." An empty
  `subscription` array removes the subscription. Async 202 + `Location`. Rate limit 40 requests per
  minute per workspace. Needs `ccs.device-management.edit`. In GET responses, `subscription[].id` is a
  uuid, distinct from `subscription[].key` (e.g. `SIEIAASTEST018ID`), so the account value must be the
  subscription's UUID, not its key (account label `domain/vocabulary.ts`: "HPE GreenLake (subscription
  id)"). ServiceNow: "the value defined for the HTTP method overrides the value from the parent REST
  message" when both set the same header.
- **GreenLake auth.** Create a personal API client (service "GreenLake Cloud Platform"), up to 7 per
  workspace. Tokens are OAuth bearer tokens and inherit the creating user's permissions. "GreenLake
  tokens stay valid for 15 minutes." The token is issued with `grant_type=client_credentials`,
  `Content-Type: application/x-www-form-urlencoded`, at
  `https://global.api.greenlake.hpe.com/authorization/v2/oauth2/<workspace id>/token` (workspace id as
  hex without hyphens). ServiceNow's third-party OAuth provider supports the Client Credentials grant.
  Optional comment for `oem/rest-messages.now.ts`: "GreenLake: Client Credentials grant, token URL
  https://global.api.greenlake.hpe.com/authorization/v2/oauth2/<workspaceId>/token, API client user
  needs Devices and Subscription edit permission."
- **FortiCloud products/list.** KB: "FortiCare Registration API v3 Resource Base:
  /ES/api/registration/v3/" on support.fortinet.com; resources `products/list`, `products/register`,
  `products/details`, `products/description`, `products/location`, `licenses/register`,
  `licenses/download`. Example
  `curl --request POST 'https://support.fortinet.com/ES/api/registration/v3/products/list'` with
  Bearer auth and JSON. "serialNumber or expireBefore must be used in the POST body." For
  Organization scope the body must also carry `accountId`: if the Provider's IAM API user is
  Organization-scoped, `products_list` content must include `"accountId": <number>`
  (`oem/rest-messages.now.ts`).
- **FortiCloud response.** KB sample:
  `{"build":"1.0.0","error":null,"message":"Request processed successfully","status":0,"token":...,"version":"3.0","assets":[{"description","entitlements": [{"endDate","level","levelDesc","startDate","type","typeDesc"}],"isDecommissioned","productModel", "registrationDate","serialNumber","warrantySupports","assetGroups","contracts":[{"contractNumber", "sku","terms":[{"endDate","startDate","supportType"}]}],"productModelEoR","productModelEoS"}]}`.
  The entitlement fields `levelDesc`, `typeDesc`, `startDate` and `endDate` match. The third-party
  hfortix-forticare SDK corroborates "status: API call status code, 0 means success". Today HTTP
  status alone decides success (`domain/oem/sync-adapters.ts`), so an HTTP-200 API error can stamp
  serials as checked with no coverage.
- **FortiCloud limits.** KB "Limits and Quotas": maximum 100 calls per minute, 1000 calls per hour,
  10 errors per hour; maximum 10 units per batch registration; maximum 5 errors per batch
  registration. Coverage loads 200 stale serials at a time and calls `products_list` once per serial
  (`domain/oem/sync-adapters.ts`) until `x_daas_ham.job.budget_seconds` (default 120 s), every 4
  hours. The claims budget (`x_daas_ham.oem.claim.max_calls`, default 8 per vendor per 5-minute run,
  `platform/claim-steps.ts`; about 96 per hour) is within the limits.
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
  devices by entering multiple device serial numbers." "The FortiZTP v2.0 API is available." In the
  UI, FortiManagers are added under Settings > FortiGate > Provision Target (serial number and
  IP/FQDN) before provisioning. The app's 8 calls per 5 minutes (about 96 per hour) is within 2000
  per hour. Account label `domain/vocabulary.ts`: "FortiZTP (FortiManager OID)".
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
  (`DEFAULT_CLIENT_ID = 'fortiztp'`) both use `fortiztp`. The same ServiceNow ROPC client-secret
  caveat as FortiCare applies. Suggested comment for `oem/rest-messages.now.ts`: "FortiZTP:
  FortiCloud IAM API user, password grant at
  https://customerapiauth.fortinet.com/api/v1/oauth/token/, client_id from the credentials ZIP
  (normally "fortiztp")".
- **FortiZTP errors.** pyfortiztp README ("Error messages are provided as is, from the FortiZTP API"):
  `{"error":"invalid_request","error_description":"Device testSN doesn't exist in this account"}`;
  success 204 No Content. The official IAM page shows the same `{error, error_description}` shape for
  the token endpoint. Success handling (any 2xx, `domain/oem/claim-adapters.ts`) matches.

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
| Zero Touch base URL and path | `POST https://zerotouch.checkpoint.com/api/v1/gateways`, once per device (`oem/rest-messages.now.ts`, `domain/oem/claim-adapters.ts`) | Every command is `POST https://zerotouch.checkpoint.com/ZeroTouch/web_api/v2/<command>`; no `/api/v1/gateways` | differs | K1, K2, K3, K4 |
| Zero Touch authentication | `X-API-Key: ${api_key}` from one password2 property (`oem/rest-messages.now.ts`, `platform/rest-messages.ts`) | `login` with `api-client-id` and `api-key` returns a `sid`, sent as `X-chkp-sid`; no `X-API-Key` | differs | K5, K6, K7 |
| Zero Touch claim body | `{serialNumber, template}`; requires serial (`domain/oem/claim-adapters.ts`) | `claim-gateway` takes `object-name`, `account-id` (int), `template-id` (int), `mac`; no serial | differs | K1, K8, K2, K9 |
| ShipEngine base URL, auth header, labels path | `POST https://api.shipengine.com/v1/labels`, header `API-Key: ${api_key}` (`delivery/logic.now.ts`) | Same | matches | S1, S2, S3, S4 |
| ShipEngine `shipment.carrier_id` | Not sent; `service_code` from a property (`domain/shipping.ts`) | `carrier_id` is required | differs | S1, S4 |
| ShipEngine `ship_to` / `ship_from` | Field names as spec; empty optionals sent as `''` (`domain/shipping.ts`) | Names match; `ship_from.phone` and `state_province` required with minLength 1 | partially | S1 |
| ShipEngine packages and label format | `weight {value, unit:'kilogram'}`, `label_messages.reference1`, `label_format:'pdf'` (`domain/shipping.ts`) | Same | matches | S1, S4 |
| ShipEngine label response | `label_id`, `tracking_number`, `carrier_code`, `label_download.pdf`/`href`, `shipment_cost` (`domain/shipping.ts`) | Same; sample currency lowercase; label URL valid 90 days | matches | S1, S4 |
| ShipEngine track webhook payload | `data.tracking_number`, `status_code`, descriptions, dates, `events[]` (`domain/shipping.ts`) | Same fields | matches | S5, S6, S1 |
| ShipEngine `status_code` values | 8 codes mapped (`domain/shipping.ts`) | Enum UN, AC, IT, DE, EX, AT, NY, SP | matches | S1, S7, S6 |
| ShipEngine webhook URL auth | `?token=` in the URL (`entry/shipping.ts`, `shared/rest-api.now.ts`) | Query strings not documented; custom headers and RSA-SHA256 signatures documented | partially | S1, S5, S8 |
| ShipEngine webhook delivery and retries | A delivery held off by the Shipment's tracking lock is answered 503 for the aggregator to send again (`entry/shipping.ts` `postTrackingUpdate`, commit e197f67) | 10 s to answer 2xx; then at most two more attempts, typically 30 minutes apart, and the event is dropped | differs | S9, S10 |
| EasyPost Event envelope | Any body with `result.tracking_code` is a tracking update (`domain/shipping.ts`) | `result` can be another object type, e.g. Insurance, which also has `tracking_code` | partially | E1, E2, E3 |
| EasyPost Tracker fields and status values | `tracking_code`, `status`, `status_detail`, `est_delivery_date`; 10 statuses (`domain/shipping.ts`) | Same | matches | E4 |
| EasyPost `tracking_details[]` | Field names; last element is the latest scan (`domain/shipping.ts`) | Field names match; order not documented | partially | E4 |
| EasyPost webhook URL auth | `?token=` in the URL | HMAC signature, Basic auth in URL, up to 3 custom headers; query strings not mentioned | partially | E5, E3 |

Notes:

- **Zero Touch commands.** Documented commands: `login`, `logout`, `show-all-accounts`,
  `show-all-templates` (body `{"account-ids":[int]}`, response `template-id`, `account-id`, `name`,
  `plan`, ...). Small Office (Quantum Spark) gateways use `add-template`, `show-template`,
  `set-template`, `claim-gateway`, `show-claimed-gateway`, `show-claimed-gateway-status` and
  `unclaim-gateway`. Gaia gateways use the same set with a `gaia-` prefix (`claim-gaia-gateway` etc.).
  Success is HTTP 200; failure is 400, 401 or 500 with `{message, messages[], code}`. No rate limits
  are stated. The comment at `oem/rest-messages.now.ts` says the endpoint is still to be confirmed.
- **Zero Touch auth.** `POST .../ZeroTouch/web_api/v2/login`, `Content-Type: application/json`, body
  `{"api-client-id": string (mandatory), "api-key": string (mandatory)}`, both generated in the Zero
  Touch Web Portal. The 200 response carries `sid`, `user`, `url` and `last-login-was-at`. `X-chkp-sid`
  is "mandatory in all API calls except the login API". `POST .../logout` with `X-chkp-sid` ends the
  session (`{"code":"17999","message":"Logout succeeded"}`). Admin Guide: keys are generated under
  Options > Manage API Key, one key per user, validity 1-180 days (default 90), shown only once.
- **Zero Touch claim.** `claim-gateway` ("Claims a Small Office Gateway with a template-id"),
  headers `Content-Type: application/json` and `X-chkp-sid`. Mandatory: `object-name` (string, the
  gateway's name), `account-id` (int, the User Center account that owns gateways and templates),
  `template-id` (int), `mac` (string, e.g. `xx:xx:xx:7A:B3:4E`). Optional: `under-construction`
  (boolean, default false). The 200 response is an array with `gateway-configuration`
  (`template-name` ...), `creation-time`, `last-modify-time` and `gateway-status` (`status-value`
  "set", `display-status` "Ready to deploy"). Template ids come from `show-all-templates`. Gaia
  appliances use `claim-gaia-gateway` with the same four mandatory fields. Today the customer
  account is one string in `x_daas_ham_cloud_account.account_id`, labelled "Check Point Zero Touch
  (template)" (`domain/vocabulary.ts`); success means any 2xx; test at `domain/oem/claims.test.ts`.
  The demo model in `entry/demo-seed.ts` is `CPAP-SG3600` (Quantum 3600); the researcher's
  unverified understanding is that it is a Gaia appliance, which would need `claim-gaia-gateway`.
- **ShipEngine basics.** OpenAPI "ShipEngine API" 1.1.202604070904: servers
  `[https://api.shipengine.com]`, `/v1/labels` POST, operationId `create_label` ("Purchase Label");
  security scheme `api_key` (apiKey, header `API-Key`). Missing or invalid key gives 401. Sandbox keys
  start with `TEST_`. Rate limit 200 requests per minute by default (sandbox 20), 429 with
  `Retry-After` above it. Error body `{request_id, errors:[{error_source, error_type, error_code,
  message, ...}]}`, which `errorText` (`domain/http.ts`, `errors[0].message`) already reads. The key
  comes from `x_daas_ham.shipping.api_key` (`platform/rest-messages.ts`).
- **ShipEngine carrier_id.** `shipment_request` has
  `required: ["carrier_id", "service_code", "ship_to", "packages"]`. `carrier_id` is an se_id string
  (pattern `^se(-[a-z0-9]+)+$`, e.g. `se-28529731`), "The carrier account that is billed for the
  shipping charges". "Either ship_from or warehouse_id must be set". The docs example sends
  `"carrier_id": "se-123456", "service_code": "ups_ground"` and says to "use the standard label
  creation endpoint (POST /v1/labels) with explicit carrier_id and service_code". Rate shopper and
  `shipping_rule_id` are the alternatives. The app's service code defaults to `ups_standard`
  (`x_daas_ham.shipping.service_code`, `delivery/logic.now.ts`).
- **ShipEngine addresses.** Spec field names: `name`, `phone`, `email`, `company_name`,
  `address_line1`, `address_line2`, `address_line3`, `city_locality`, `state_province`,
  `postal_code`, `country_code`, `address_residential_indicator` (unknown, yes, no), `instructions`.
  `ship_to` requires `name`, `address_line1`, `city_locality`, `state_province`, `postal_code`
  (`country_code` optional, length 2). `ship_from` requires `name`, `phone`, `address_line1`,
  `city_locality`, `state_province`, `postal_code`, `country_code`. `phone` and `state_province` have
  minLength 1; `company_name` and `address_line2` are nullable. `state_province`: "For some countries
  (including the U.S.) only abbreviations are allowed." On return labels `ship_from` is the Site
  (`cmn_location.phone`). The app's `addressProblem` (`domain/shipping.ts`) requires only name,
  line1, city, postal code and country.
- **ShipEngine packages.** `packages[].weight` is required: `{value (number), unit (pound, ounce, gram,
  kilogram)}`. `label_messages` (`reference1`-`reference3`) is listed as required but nullable with
  default null. Line limits per carrier: UPS 2 lines x 35 characters, FedEx 3 x 35/30, USPS 3 x 60.
  `label_format` is pdf, png or zpl (default pdf, "supported by all carriers"); `label_download_type`
  defaults to `url`.
- **ShipEngine label response.** `create_label_response_body` requires `label_id`, `status`
  (processing, completed, error, voided), `tracking_number`, `carrier_id`, `carrier_code`,
  `service_code`, `shipment_cost {currency, amount}` and `label_download {href, pdf, png, zpl}`. The
  sample has `"currency": "usd"`, which the app uppercases (no default: blank when absent, and
  Margin counts such a cost as failed). "The URL will remain valid for 90 days." Operational note:
  `x_daas_ham_shipment.label_url` expires after 90 days, so download or attach the PDF if it must be
  kept.
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
  `out_for_delivery` (`domain/shipping.ts`); pick one meaning for both. ShipEngine cannot produce
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
  `domain/shipping.test.ts` uses `{object:'Event', description:'tracker.updated', result:{...}}`.
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
| `alm_asset.substatus` choices shipped by the app | 12 separate `sys_choice` Records each ship (`fleet/tables.now.ts`, ADR 0002) | All share one update name; the built XML holds only `returned_to_lessor` | differs | N1, N2, N3, N4, N5 |
| Added substatus values vs out-of-box | Out-of-box values are not listed; adds `pending_evaluation`, `pending_return`, `returned_to_lessor` (`domain/vocabulary.ts`) | Out-of-box In stock already has Pending return and Pending evaluation; Retired has Lease return and RMA | differs | N6, N7 |
| `alm_asset.install_status` values | 1 in use, 2 on order, 3 in maintenance, 6 in stock, 7 retired, 8 missing, 9 in transit (`domain/vocabulary.ts`) | Same values; also Build (11) | matches | N7, N8 |
| Out-of-box substatus values (`STAGE_FIELDS`) | `available`, `reserved`, `pending_disposal`, `lost`, `disposed`, `sold`, `vendor_credit` (`domain/vocabulary.ts`) | Labels match; only `available` confirmed as a stored value | partially | N6, N7, N8 |
| `alm_asset.cost` and `purchase_date` | `getValue('cost')`; `setValue('cost', number)` (`platform/margin.ts`, `platform/leases.ts`) | Currency field; `getValue()` and a plain number use the session currency | partially | N9, N10, N8 |
| `proc_po` fields and status | `short_description`, `status='requested'`, `ship_to` only if supplied (`platform/procurement.ts`) | Ship to is documented as required; status labels only | partially | N11, N12 |
| `proc_po_item` and open quantity | Excludes lines only by PO status (`platform/procurement.ts`) | Line items can be canceled one at a time | partially | N13, N14 |
| `wm_order` state 3 = Closed Complete | `current.state == 3` (`delivery/logic.now.ts`, `platform/delivery.ts`) | Docs list state labels only; the number 3 appears only in community posts | unverifiable | N15, N16, N17, N18, N19 |
| `wm_order` fields | `closed_at`, `expected_start`, `estimated_end`, `company`, `location`, `parent`, `short_description`, `work_notes` | task has `closed_at`, `expected_start`, `parent`, `company`, `location`; no source for `estimated_end` or that `wm_order` extends task | partially | N20, N21, N22 |
| `cmdb_ci.last_discovered`, `discovery_source` | `discovery_source === 'ServiceNow'` means ServiceNow Discovery (`domain/in-service.ts` `seenSourceOf`) | Both fields exist; examples pass `ServiceNow`; no page says Discovery writes it | partially | N23, N24 |
| `GlideSysAttachment.write()` and `deleteAttachment()` | As used (`platform/billing.ts`) | Same signatures | matches | N25, N26 |
| `sys_attachment` fields | `table_name`, `table_sys_id`, `file_name` (`platform/billing.ts`) | Documented | matches | N27, N28 |
| Scripted REST `request.queryParams` | Each parameter is an array (`platform/rest-api.ts`) | Type Array; examples are arrays | matches | N29 |
| `GlideRecord.updateMultiple()` and clearing a field | Clears `billing_period` record by record (`platform/billing.ts` takeOffPeriod) | `updateMultiple` does not clear values unless set to `'NULL'` | matches | N30 |
| `RESTMessageV2(name, methodName)`, `setStringParameterNoEscape` | As used; app URL-encodes values itself (`platform/rest-messages.ts`) | Constructor documented; neither method URL-encodes | matches | N31, N32, N33 |
| `GlideAggregate.groupBy` on date fields | Grouped `start_date`/`end_date` read as `YYYY-MM-DD` (`platform/billing.ts` intervalsByLine) | Format of a grouped `glide_date` key not documented | unverifiable | N34 |
| `setWorkflow(false)` on a global table from the scoped app | No longer relied on there: a read past the visibility rules on `alm_hardware` marks its GlideRecord while its query runs and the app's before-query rules skip a marked record (`platform/beyond-visibility.ts`, `entry/visibility.ts` `scopeRecords`); `setWorkflow(false)` stays on `x_daas_ham_*` tables | "This method can't be set for cross-scoped applications"; refused on the instance, so the rules still run. Module state reaches the rules the query sets off, within that transaction only | matches | N30, N35, N37 |
| `current.setAbortAction(true)` in a before rule on a global table | No longer used there: the rules on `alm_hardware` and `wm_order` refuse with their Abort action (`entry/assets.ts` refusesLifecycleChange, `entry/delivery.ts` refusesWorkWindow, `entry/racks.ts` refusesRackPlacement); the rules on `x_daas_ham_*` tables keep it | Refused on the instance: the save goes through. The rule's own Abort action refuses it, whoever saves, and its script still runs | matches | N35, N36 |
| Business rule condition and filter | The check is the condition, behind a change test in the condition itself (`delivery/logic.now.ts`, `racks/racks.now.ts`) | The condition runs on every save the rule's table and action match, even when the filter does not; the rule fires only when both hold | matches | N36 |
| Out-of-box transfer order line logic and the Asset | Inventory works the transfer orders sourcing raises, each unit handed over *In stock / Available* just before its line is inserted (`platform/transfers.ts` requestTransfer). Both combinations Inventory sets are one stage, *In transfer*, entered only while `active_to` is set and left only once it is cleared (`domain/lifecycle.ts`, `entry/assets.ts` refusesLifecycleChange); an Asset Inventory lets go takes back the stage it left (`platform/transfers.ts` takeBackStageAfterTransfer) | *Push Status to Asset/Consumable* sets *In stock / Pending transfer* or *In transit / Reserved* with `active_to` set, and *In stock / Available* in the to-stockroom with it cleared at Received; *Release Asset on TOL cancel/delete* sets *In stock / Available* where the Asset is and clears it; *Validate TOL and check availibility* takes onto a line only an Asset *In stock / Available* with `active_to` clear. Each saves through `alm_asset` in the user's transaction, and the app's `alm_hardware` rules run on that save | matches | N38, N39 |
| The platform's Model lifecycle table | A Model's manufacturer milestones are rows of `cmdb_model_lifecycle`, written as `cmdb_hardware_model_lifecycle` with lifecycle type `publisher`, source `internal`, the milestone as `lifecycle_phase` and its date as `start_date`; a write updates the active row of one Model, type, phase and source and never deletes; asset managers hold `model_manager` (`platform/model-lifecycle.ts`, ADR 0017) | Both tables are Model Management's (`com.snc.model`), with those columns and phase values; before rules refuse an insert without a start date, a second active row for one Model, type, phase and source, and a hardware lifecycle row for a Model that is not a hardware Model; this scope may read, create and update, not delete; create and write need `model_manager`, read `snc_internal` | matches (the app's use was not run on the instance) | N40 |
| Platform fields the app uses in place of its own | An inventory tech's Stockrooms from `alm_stockroom.assignment_group` and `sys_user_grmember` (`platform/session.ts`); a Model's typical power from `cmdb_model.power_consumption` (`platform/racks.ts`); a lease's Lessor and schedule number in `ast_contract.vendor` and `vendor_contract`; on-site work linked through `wm_order.initiated_from` and `change_request.parent` (`platform/field-work.ts`, the rules on `wm_order`); ADR 0018 | The columns exist with those types; `sys_user_group` lets other scopes read only, `sys_user_grmember` read, create and update; no platform rule reads a contract's vendor fields, a work order's *Initiated from* or (beyond running the parent's workflows) a task's *Parent* | matches (the app's use was not run on the instance) | N41 |
| ATF *Record Validation* on a date field | The ATF tests check a date with the `ON` form, `endsON2028-01-31@javascript:gs.dateGenerate('2028-01-31','start')@javascript:gs.dateGenerate('2028-01-31','end')` (`src/fluent/leases/tests.now.ts`) | The step matches the record loaded in memory against the condition, not the database, and there a date `=` a literal day is shifted by the session time zone; `ON` matches the day in every time zone | matches | N42 |
| A row inserted into an import-set table outside an import set | The app processes its import rows by business rule and ships no transform map (ADR 0018); an ATF test that inserts such a row does not fail on server errors and checks the outcome (`src/fluent/models/tests.now.ts`) | The platform transforms the row at once and, where the table has no transform map, logs the error *Transform map record not provided, transform stopped*; the insert is written and the app's rule runs | matches | N43 |
| `gs.getPropertySecured` and a password2 property's read roles | Every secret is read with `gs.getProperty` (`platform/properties.ts` secretProperty), not `gs.getPropertySecured`; each declares read and write roles `admin`; the tracking webhook reads its token as guest, and *Ship* and *Create return label* read the ShipEngine key as asset managers or inventory techs | Not documented (only the signature in the typings). On an instance `getPropertySecured` checks the property's read roles against the session user and gives a non-admin the default; `getProperty` gives everyone the stored value | matches | N44, N45 |
| A work note on a task-extended table | A note is added by assigning `work_notes` (`platform/records.ts` addWorkNote) and stored by the next insert or update, even one that changes nothing else | `setValue('work_notes', x)`, `setValue('comments', x)` and `getElement(f).setValue(x)` store nothing, in global and in `x_daas_ham`: the field reads back blank and a save with nothing else changed writes nothing yet returns the sys_id. Assignment stores one journal entry per assignment. `setJournalEntry` and `setDisplayValue` are refused in `x_daas_ham`. A journal field reads blank once read or saved | matches | N46 |
| A record producer request refused before its insert | A Customer contact's request is refused in the producer's own script (`entry/orders` beforeOrderProduced, `entry/returns` beforeReturnProduced), before the before-insert rules that refuse every other insert | Refused by a before-insert business rule, the platform still writes the request's answers to `question_answer` and skips the post-insert script. Refused by `current.setAbortAction(true)` in the producer's script, it writes no answer and skips the post-insert script. That script sees the mapped values. `question_answer` is global with *Can delete* off and the app holds no privilege on it | matches | N48 |
| Who may open a record producer | Each producer is *Available for* one user criterion with the app's requester roles in its role list and the service desk's matched by name in its script (`shared/roles.now.ts` producerRequesters); the platform's *Not available for: SNC External* is removed by an admin in global scope after the install (README "Install"); the preflight check reports a producer that still has a *Not available for* row | The platform adds *Not available for: SNC External* in the insert of every catalog item, and again whenever one is left with no criterion; *Not available for* wins over *Available for*. The row is in no update set, the update loader deletes by sys_id only, `Now.del` by keys mints a new sys_id, and `x_daas_ham` may not delete from `sc_cat_item_user_criteria_no_mtom`. A role's sys_id differs between instances (roles coalesce on name) | matches (the criterion's script was not run on an instance) | N49 |
| Deleting a record producer's own record | A record its post-insert script refuses is deleted read again by its sys_id (`platform/records.ts` removeStored), not through the script's `current` | `current.deleteRecord()` in the post-insert script returns false, as admin too, with *Error during delete of ...* and a NullPointerException in `com.glide.db.PrimaryKey.getValue`; the row stays. A GlideRecord read by the same sys_id deletes it | matches | N47 |
| Who reads a platform table the app's records point at | Provider staff read `customer_account` and its `name`, the broad staff `core_company`, `cmdb_ci` and `proc_po`, through the app's Allow-If ACLs on those global tables (`shared/platform-access.now.ts`, `orders/access.now.ts`, `assurance/access.now.ts`); field ACLs on the Agreement and Lease schedule tables, for read and query_range, replace `ast_contract`'s and name every role that reads each field (`agreements/access.now.ts`, `leases/access.now.ts`); the workspace audience check judges platform tables by the ACLs recorded in `src/server/test-support/platform-acls.ts` | A reference shows, and is searched or grouped by, only when the reader reads its table and that table's display field. `customer_account`'s ACLs name Customer Service and CRM roles only; `core_company`, `cmdb_ci` and `proc_po` name roles inside the platform's `asset`, which the NOC, account managers and finance do not hold. `ast_contract.*` read and query_range need `contract_manager`; `number`, `short_description`, `state`, `starts` and `ends` read also pass the service desk; `starts`, `vendor`, `vendor_contract` query_range need `contract_manager`. A field is decided at the most specific level with an ACL for it, ORed within the level: field on the table, on each parent, `*.<field>`, then `*` on the table and each parent. Every other field's query_range is public (`*.<field>`). An app-scoped ACL on a global table installs in the app's scope | matches (emulated with app-scoped ACLs made by REST on the instance, not installed from the build) | N50 |

Notes:

- **Substatus choices.** SDK 4.14.0 `choice-set-plugin.ts:129-136` refuses `ChoiceSet` on a table
  the project does not define ("Only tables defined in your scope are allowed"). Every `sys_choice`
  record gets the same update name, `choice-set-utils.ts:25-27` `sys_choice_${name}_${element}`, so
  all 12 Records write to one update file. `dist/app/update/sys_choice_alm_asset_substatus.xml`
  (built 2026-11-07 03:13, newer than the source file) holds exactly one `<sys_choice>`:
  `returned_to_lessor`. This was reproduced with `now-sdk build` in a scratch copy; the build
  succeeds with no warning. `domain/vocabulary.ts` (`ADDED_SUBSTATUSES` then, now the `choice`
  entries of `STAGE_FIELDS`) and its test only checked that the source file and the module agree.
  The SDK config schema (`now.config.schema.json`) says `legacyChoices` defaults to true; in that
  mode the choice-set XML is "v3 destructive delete-all-then-insert". With `legacyChoices` false it
  is "v4 additive merge with removed_choices tracking, supported on Brazil+, Australia P4+, Zurich
  P11+", and older instances skip it. ServiceNow's application-access docs say nothing about one
  scope adding choices to another scope's field.
- **Substatus collisions.** Xanadu "Set asset states and substates": In stock includes "Pending
  return" and "Pending evaluation"; Retired includes "Lease return" and "RMA". The infocard
  (2024-01-16) also lists "Pending evaluation" under In stock (6). Neither source gives the stored
  value. The app adds `pending_evaluation` (In stock, 6; `domain/vocabulary.ts`,
  `fleet/tables.now.ts`), `pending_return` (In use, 1) and `returned_to_lessor` (Retired, 7).
- **install_status.** The infocard "OOTB Asset - CI State" labels On order (2), In stock (6), Retired
  (7), Missing (8), Build (11), In transit (9), In use (1), In maintenance (3). The SDK
  (`alm_asset.now.ts:950-961`) has `install_status` as an IntegerColumn, default `'1'`, label "State".
  The app names the values once, in `domain/vocabulary.ts` `INSTALL_STATUS`.
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
  purchased." Billing amounts are Decimal fields in their Agreement's currency.
- **Procurement.** Brazil "Create a purchase order" lists Number, Due by, Vendor, Ship to ("This
  field is required"), PO date, Status (Canceled, Ordered, Received, Requested, Suspended), Short
  description and others; Vendor is not marked required. The status page: Requested when created,
  then Ordered, Pending delivery, Received or Canceled. Line items: Purchase order, Product Model,
  Ordered quantity, Received quantity, Remaining quantity, Cost, Total cost, Status (Canceled,
  Ordered, Pending Delivery, Received, Requested). Zurich "Cancel a purchase order": unreceived
  lines are canceled with the PO, and line items can also be canceled one at a time. Column names
  and stored values are not public. The app never sets `vendor`; `platform/spare-pools.ts` can pass
  `''` as ship-to when the staging stockroom property is empty; `openSparePurchaseQuantity`
  (`platform/procurement.ts`) excludes only POs whose `purchase_order.status` is in
  `received,canceled,cancelled`. Optionally set item `cost` so Total cost and received asset cost
  are not 0.
- **Work orders.** Xanadu and Zurich "Work order states" list Draft, Awaiting Qualification,
  Qualified, Ready for Dispatch, Assigned, Accepted, Work in Progress, Closed Complete, Closed
  Incomplete and Canceled, without numbers; the Work Order Management API lists text labels only.
  `task.state` in the SDK is an IntegerColumn with default `'1'`. Closing child tasks closes the
  parent work order, and the `wm_task` rule "Rollup changes" updates the work order's state. For
  fields: the SDK task definition has `closed_at` (DateTime), `expected_start` (DateTime), `parent`
  (reference to task), `company` (reference to core_company) and `location`; Table API examples show
  these names on task-derived records. FSM "Create a work order" labels: Company, Location, State,
  "Initiated from", Scheduled start ("when the earliest task is scheduled to start") and Estimated
  end ("when all tasks will be completed"). App usage: `platform/field-work.ts` writes and reads,
  `platform/margin.ts` filters on `closed_at`, `delivery/logic.now.ts` watches `expected_start` and
  `estimated_end`.
- **CMDB.** SDK `cmdb_ci`: `last_discovered` is a DateTimeColumn "Most recent discovery";
  `discovery_source` is a StringColumn dropdown "Discovery source". IdentificationEngine
  `createOrUpdateCI` source "must be one of the choice values defined for the discovery_source field of
  the cmdb_ci table"; its examples pass `ServiceNow`; `skip_updating_source_last_discovered_to_now`
  controls updates to "the discovery_source and last_discovered fields".
- **Attachments.** `write(GlideRecord record, String fileName, String contentType, String content)`
  "Attaches a specified attachment to the specified record" and returns the sys_id, or null if not
  added (the app logs a CSV export that returns none as failed, `platform/billing.ts`
  `attachExport`). `deleteAttachment(String attachmentID)` returns void. The
  `@servicenow/glide` 27.0.5 typings match. `sys_attachment` in the SDK: `file_name` (String, max 100),
  `table_name` (String, max 80), `table_sys_id`, `content_type`.
- **queryParams.** `RESTAPIRequest.queryParams` type "Array": "The query parameters from the web
  service request." Example: `queryParams.active // [false]`, `queryParams.name // ['now']`.
- **updateMultiple.** "This method sets new values and does not clear existing values. To clear an
  existing value, use the setValue() method and set the field to 'NULL'." Also "use the setValue()
  method instead of direct assignments" and "Do not use this method with the chooseWindow() or
  setLimit() methods when working with large tables." The docs example calls `addQuery`, `setValue`,
  `updateMultiple`, with no `query()`. Optional simplification in `platform/billing.ts` takeOffPeriod:
  `fee.setValue('billing_period', 'NULL'); fee.updateMultiple()`; the current loop is also correct.
- **RESTMessageV2.** Scoped and global, `sn_ws` namespace:
  `RESTMessageV2(String name, String methodName)`; name is "The name of the REST message record in
  the REST Message [sys_rest_message] table"; methodName is "The name of the HTTP method to use,
  such as GET/get or PUT/put - case insensitive". Example
  `new sn_ws.RESTMessageV2("Yahoo Finance", "get")` with the comment "Might throw exception if
  message doesn't exist or not visible due to scope." `setStringParameterNoEscape` is "equivalent to
  setStringParameter but does not escape XML reserved characters". The built `sys_rest_message` is
  named "NaaS Cisco Support" with access `package_private`, and its `sys_rest_message_fn` has
  `function_name` `eox_by_pid`. The app casts around typings that declare a Rhino constructor.
  `platform/rest-messages.ts` also URL-encodes parameters substituted into JSON body templates (e.g.
  FortiCare `products_list`); this is harmless for alphanumeric serials.
- **GlideAggregate.** `groupBy(String name)`: "May be called numerous times to set multiple group
  fields." No notes on date fields. Time bucketing uses `addTrend(fieldName, timeInterval, numUnits)`.
  Aggregates on currency or price fields use the reference currency; the app aggregates Decimal fields
  only. The table is `x_daas_ham_service_interval`; the code reads `getAggregate('COUNT','')`.
- **setWorkflow.** "This method can't be set for cross-scoped applications" (KB0820691). It is also
  ignored when `deleteMultiple()` cascades. The `platform/billing.ts` call on the app's own
  billing-line table is harmless; its comment already explains that the guard has nothing to block.

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
- N35: Brazil instance, 2026-11-09, script output of a probe in scope `x_daas_ham` that saved
  nothing: on `alm_hardware` and `wm_order`, "Security restricted: Access to api 'setAbortAction' from
  scope 'x_daas_ham' has been refused due to the api's cross-scope access policy" (`isActionAborted()`
  stays false) and, for `setWorkflow`, "setWorkflow can only be called from within the same Scope as the
  Table on which it is called. Table's Scope was: Global"; neither on `x_daas_ham_billing_line`. Both
  calls return without an error and the system log shows nothing. An ATF save of `alm_hardware` refused
  only that way was written.
- N36: Brazil instance, 2026-11-09, probe with a temporary before-update rule of `x_daas_ham` on
  `alm_hardware` (deleted after, with its probe Asset): Abort action set, filter
  `serial_numberSTARTSWITHABORTPROBE`, a condition that logs, calls a function of an installed
  module (`require('x_daas_ham/naas-ham/0.1.0/src/server/platform/records.ts')`) on `previous` and
  holds for one serial, and a script that logs and adds an error message. A save of that serial,
  from scope `x_daas_ham` and from global, returned no sys_id, `isActionAborted()` was true, the
  stored record kept its value, the script ran, and `getLastErrorMessage()` read "Operation against
  file 'alm_hardware' was aborted by Business Rule '<rule name>^<record sys_id>'. Business Rule
  Stack:<rule name>" (the name cut to 40 characters), not the script's message. A save the filter
  does not match ran the condition all the same (its log line is in the system log); with the
  condition then pointed at that save, it was written. In the same scope, `setAbortAction` on an
  unsaved record of `x_daas_ham_staging_task`, `x_daas_ham_disposal_order` (both extend `task`),
  `x_daas_ham_disposal_line`, `x_daas_ham_billing_line` and `x_daas_ham_billing_period` leaves
  `isActionAborted()` true; on `alm_hardware` and `wm_order`, false.
- N37: Brazil instance, 2026-11-09, probes in scope `x_daas_ham` (background scripts through
  `sys.scripts.do` in one session, and temporary before-query rules of `x_daas_ham` on
  `alm_hardware`, deleted after with their update records) that saved nothing. A property set on an
  object exported by an installed module (`domain/roles.ts` `ROLE`) is seen by a second `require()`
  in the script, by the before-query rule its query sets off, and by a second rule a query in the
  first rule's script sets off; it is gone in the next transaction, even in the same session, where
  the session's client data (`putClientData`) is still set. A module's import gives the instance the
  script's `require()` gives (`domain/returns.ts` read the `DEPLOYED_STAGES` of
  `domain/lifecycle.ts` as the script had changed it). A rule's `current` is the GlideRecord whose
  `query()` or `get()` set it off (`===`), also one made and returned by module code
  (`platform/records.ts` findById); another GlideRecord queried meanwhile is not. A property set on
  the GlideRecord itself, and a global variable of the script, reach the rule too. A rule is not run
  again for a query made in its own script. From global, `require()` of the app's module fails:
  "Module ... not found". `setWorkflow(false)` on `sys_user` and `alm_transfer_order_line` is
  refused like on `alm_hardware` (`isWorkflow()` stays true); on `x_daas_ham_order_line` it applies.
  Only the app may add a before-query rule to an app table: the platform's *Reject before-Q for
  out-of-scope tables* refused one saved from global on a table of the app.
- N38: Brazil instance, 2026-11-09. Read on the instance: the before rule *Push Status to
  Asset/Consumable* on `alm_transfer_order_line` (global, order 500, insert and update, condition
  `!current.isActionAborted() && (current.stage.changes() || current.asset.changes() ||
  current.operation() == 'insert')`) reads the line's Asset through `GlideRecord('alm_asset')`. It
  sets install status 6 / substatus `pending_transfer` at Draft (on insert), and, when the line's
  last closed task was not Closed Skipped, 6 / `pending_transfer` at Requested and Shipment
  Preparation, 9 / `reserved` at In Transit, and 6 / `available` in the transfer order's
  to-stockroom at Received (with no work order task or service order on it). It then calls
  `asset.update()` and ignores the result. The after rule *Push stages of TO and TOL* on
  `alm_transfer_order_line_task` (state changes to 3 or 7) sets the line's stage with
  `TransferOrderLineTemplateTaskAPI.pushStageOfTOAndTOLFromTOL`, which saves the line
  (`tolGr.update()`) in the same transaction, so the Asset save runs in the transaction of whoever
  closes the task. Probe in global scope with two temporary `alm_hardware` records (deleted after,
  with their audit rows): moving one from *In stock / Available* to *In stock / Staging* through
  `GlideRecord('alm_asset')` (`getRecordClassName()` `alm_hardware`) cleared its wipe evidence, as
  moving the other through `GlideRecord('alm_hardware')` did. So the app's before rule on
  `alm_hardware` ran on both saves.
- N39: Brazil instance, 2026-11-09, read through the Table API without saving anything: the
  dictionary and the scripts of Inventory's transfer order rules (package *Asset Management*, scope
  global). `alm_asset.active_to` (*Active transfer order*) is a boolean, read-only, default false.
  *Push Status to Asset/Consumable* (N38) sets it true with 6 / `pending_transfer` (Draft,
  Requested, Shipment Preparation) and 9 / `reserved` (In Transit), and false at Received, with
  install status 6 in the to-stockroom and substatus `available`, or `reserved` when the Asset was
  reserved and the line's request line names a Requested for. It keeps a `defective` or
  `pre_allocated` substatus at every stage. When the line's last closed task was Closed Skipped it
  sets no stage, and at Received or Delivered only clears the flag. On a line under a work order
  task or service order, Received keeps 6 / `pending_transfer` with the flag set and Delivered
  clears it; sourcing's transfer orders have neither. On a line's insert this before rule saves the
  Asset, so the Asset is saved, and the app's rules on `alm_hardware` run, before the line is
  written. The before rule *Release Asset on TOL cancel/delete* on `alm_transfer_order_line` (order
  10, update and delete, condition `(current.stage.changes() && current.stage == "cancelled" &&
  String(previous.stage) !== "received") || current.operation() == "delete"`) reads the line's Asset
  through `GlideRecord('alm_asset')`, sets 6 / `available` (unless `pre_allocated` or `defective`),
  clears `active_to` and `reserved_for`, and calls `update()`. It does not set `stockroom`, which
  Inventory sets only at Received, so the Asset is released where it was. On a cancel it then
  empties the line's `asset` and quantities. *Delete all Transfer Order Lines* (before delete on
  `alm_transfer_order`) deletes each line with `deleteRecord()`, so deleting a transfer order
  releases every Asset on it. The before rule *Validate TOL and check availibility* (order 50,
  insert and update, condition `current.operation() == 'insert' ||
  (current.quantity_requested.changes() || current.from_stockroom.changes() ||
  current.asset.changes() || current.model.changes())`) refuses with `current.setAbortAction(true)`
  the insert of a line whose Asset has `active_to` set (*You have attempted to add an asset already
  on an active transfer order line*), and a line whose Asset is of another Model, not in the
  transfer order's from-stockroom, not install status 6, or of a substatus other than `available`
  (`AssetUtils.determineAvailableStatus`, outside Field Service returns and drop-offs),
  `pre_allocated` or `defective` (*Severe inconsistency between asset and transfer order line*).
  After Draft it refuses any change to a line but its stage. *Push stages of TO and TOL* (N38)
  leaves the stage of a Cancelled line as it is, so a task closed after its line was cancelled saves
  neither the line nor its Asset. `alm_transfer_order_line.stage` holds `draft`, `requested`,
  `shipment_preparation`, `in_transit`, `received`, `delivered` and `cancelled`.
- N40: Brazil instance, 2026-11-09, read through the Table API without saving anything (no Hardware
  Asset Management Professional on it; both tables empty). `cmdb_model_lifecycle` (*Model
  Lifecycle*, extendable) and its child `cmdb_hardware_model_lifecycle` (*Hardware Model Lifecycle*,
  no column of its own) belong to `com.snc.model`. Columns: `model` (reference `cmdb_model`),
  `lifecycle_phase` (default `availability`; choices `availability`, `end_of_sale`,
  `end_of_support`, `end_of_extended_support`, `end_of_life`), `lifecycle_type` (default `internal`;
  `internal`, `publisher`), `source` (read-only, default `internal`; `internal`, `service_now`),
  `start_date` (*Phase start date*, a date, mandatory), `end_date`, `description` (string, 1000),
  `risk`, `active` (default true), `current_lifecycle_phase` (read-only). Application access of
  both tables: read, create and update from other scopes, not delete. Their active business rules
  are four before rules on `cmdb_model_lifecycle`, all of order 100 and refusing with
  `setAbortAction`: *Error message on invalid date format* (insert, filter `start_dateISEMPTY`),
  *Unique lifecycle creation per model* (insert and update of an active row: another active row of
  `cmdb_model_lifecycle` with the same `source`, `lifecycle_type`, `lifecycle_phase` and `model`),
  *Verfiy model on lifecycle* (a row of a class whose Model's class is not the mapped one,
  `cmdb_hardware_model_lifecycle` to `cmdb_hardware_product_model` and `cmdb_model_lifecycle` to
  `cmdb_model`, or any row for a software Model) and *Phase start and end date validation* (an end
  date not after the start date). ACLs on `cmdb_model_lifecycle`: read `snc_internal`; create, write
  and delete `model_manager`; list edit `nobody`. `model_manager` is a `com.snc.model` role;
  `procurement_user`, `sam` and `category_manager` contain it, `asset` does not. Default list of
  both tables: `model`, `lifecycle_phase`, `lifecycle_type`, `source`, `start_date`.
- N41: Brazil instance, 2026-11-09, read through the Table API without saving anything (no Hardware
  Asset Management Professional on it).
  - Stockrooms and groups. `alm_stockroom.assignment_group` (*Assignment group*) references
    `sys_user_group` and is the second field of the stockroom's default form. ACLs: create and write
    on `alm_stockroom` take `inventory_admin`; create and write on `sys_user_grmember` take
    `user_admin`. Application access: `sys_user_grmember` and `alm_stockroom` allow read, create and
    update from other scopes, not delete; `task` allows read; `sys_user_group` allows read only.
    Active before-query rules: none on `sys_user_grmember`; on `sys_user_group` the platform's *group
    query* (active groups only, for an interactive user without `admin` or `user_admin`); on
    `alm_stockroom` only the app's.
  - Models. `cmdb_model.power_consumption` is an integer labelled *Power (watts)*, on the hardware
    Model's default form. `cmdb_model.asset_tracking_strategy` (*Asset tracking strategy*, default
    `leave_to_category`) has the choices `leave_to_category` (*Leave to category*),
    `track_as_consumable` (*Create consumable asset*) and `do_not_track` (*Don't create assets*).
  - Contracts. `ast_contract.vendor` (*Vendor*) references `core_company` with the qualifier
    `vendor=true`; `vendor_contract` (*Contract number*) is a string of 40, mandatory and the table's
    display field; `number` is read-only with a number default. None of the 23 active business rules
    on `ast_contract` names `vendor` in its script.
  - Task references. `sm_order.initiated_from` (*Initiated from*, which `wm_order` inherits) and
    `task.parent` (*Parent*) reference `task`. No active business rule on `task`, `change_request`,
    `sm_order` or `wm_order` names `initiated_from`; *Date Checks* on `sm_task` reads an assigned
    crew's. The script includes that name it are `WorkManagementInitiation`, `SMDateValidation`,
    `QueryRangeACLAuditor` and Customer Service's `CaseReportUtils`. The active rules on `task` and
    `change_request` whose script names `.parent` are the three async *Affected group / location /
    cost center notifications* and *SNC - Run parent workflows* (after insert and update), which
    broadcasts an update to the workflow contexts of the parent record.
- N42: development instance (Brazil, session time zone America/Los_Angeles), 2026-11-09, ATF run
  of the app's suites. In *NaaS - extending a lease moves its end date and closes the decision*, a
  *Record Validation* step with `ends=2028-01-31` failed on a Lease schedule whose stored `ends`
  was 2028-01-31 (*Record ... did not match conditions: End date = 2028-01-31 and End-of-lease
  action = Undecided*): the step matches the loaded record in memory against the condition
  (`GlideFilter.checkRecord`), where a date compared with `=` to a literal day is shifted by the
  session time zone, so west of UTC it matches the day after. The same step with the `ON` form the
  condition builder writes
  (`endsON2028-01-31@javascript:gs.dateGenerate('2028-01-31','start')@javascript:gs.dateGenerate('2028-01-31','end')`)
  passed, and the run then passed all 14 tests.
- N43: development instance (Brazil), 2026-11-09, ATF run of the app's suites. In *NaaS - a
  lifecycle import row stores its milestones on the model*, a *Record Insert* step into
  `x_daas_ham_eox_import` (an import-set table, extending `sys_import_set_row`) outside an import
  set made the platform log *Transform map record not provided, transform stopped*, and the test,
  which then failed on any server error, failed with that message. The table has no transform map:
  the app's business rule processes the row. With *Fail on server error* off, the test passed: the
  row was inserted, the rule ran, and the steps that check the outcome held.
- N44: `node_modules/@servicenow/glide/src/types/gs.d.ts:415` (SDK 4.14), `static getPropertySecured(key?: string, alt?: any): string`,
  with no description; searched 2026-11-11, neither the ServiceNow docs nor the community describe it.
- N45: PDI, 2026-11-11, global background script, impersonated non-admin. A password2 `sys_properties`
  record with read roles and write roles `admin` and value `S3CRET-PROBE`: as admin, `gs.getProperty`
  and `gs.getPropertySecured` both returned `S3CRET-PROBE`; impersonating a user without admin
  (`GlideImpersonate`), `gs.getProperty` returned `S3CRET-PROBE` and `gs.getPropertySecured` returned
  the default `DEF`. The probe property was deleted afterwards. The probe ran in global scope, the
  app's properties are in `x_daas_ham`: *NaaS - the tracking webhook needs its token and records a
  delivery once* posts the delivery unauthenticated with the token, so it shows the scoped read as
  guest ([verify-on-instance.md](../verify-on-instance.md#atf-route-tests)).
- N46: development instance, 2026-11-12, background scripts in global and in `x_daas_ham` on
  `x_daas_ham_return_order`, `x_daas_ham_order` and `sn_customerservice_case`, and in `x_daas_ham`
  through the deployed `records` module. After `setValue('work_notes', x)` (and `comments`, and
  through `getElement`, with or without `setWorkflow(false)`), `getValue` gave `''`, `update()`
  returned the sys_id, `sys_mod_count` stayed the same and `sys_journal_field` got no entry, on
  insert and on update. After `gr.work_notes = x` the update raised `sys_mod_count` by one and
  `sys_journal_field` got the entry; two assignments before one save gave two entries. The daily job
  *NaaS - chase overdue returns* closed a Return with no line and stored no note. A fresh `get` read
  `work_notes` as `''`. The test records and the cross-scope privileges the runs granted were
  deleted afterwards.
- N47: development instance, 2026-11-12. Through the deployed producers, as a service desk agent
  (a Return for a Site of another Customer), as a user with no NaaS role (an Order) and as admin (a
  Return), the app's `current.deleteRecord()` failed: the Return and Order orders stayed open with
  their answers, the system log had *Error during delete of ...* with a NullPointerException in
  `com.glide.db.PrimaryKey.getValue`, then the app's *not removed* warning. On a copy of a producer
  writing `sys_user_preference`, `current.deleteRecord()` in the post-insert script returned false
  and the row stayed; a `GlideRecord` read by `current`'s sys_id there returned true and the row was
  gone. In `x_daas_ham`, admin deleted one of the kept Orders read the same way. Each answer of a
  deleted record stays: `question_answer.table_sys_id` is a plain string and nothing removes them.
  The test records were deleted afterwards.
- N48: development instance, 2026-11-12, a copy of a producer writing `sys_user_preference` with one
  variable, submitted through `/api/sn_sc/servicecatalog/items/{id}/submit_producer` as a service
  desk agent. Kept: one `question_answer` row for the new record, and the post-insert script logged.
  A global before-insert rule calling `current.setAbortAction(true)`: the submit answered sys_id
  `-1`, one `question_answer` row was written for a sys_id never stored, and the post-insert script
  logged nothing. `current.setAbortAction(true)` in the producer's script: sys_id `-1`, no answer,
  no post-insert log. With the variable mapped to a field, the producer's script read the posted
  value from `current`. `sys_db_object` of `question_answer`: global, *Can delete* off. With the
  app's before-insert rules, a refused contact request left 6 answers per Return and 9 per Order.
  The test records were deleted afterwards.
- N49: development instance, 2026-11-12, `GET /api/sn_sc/servicecatalog/items/{id}`,
  `submit_producer` and `sn_sc.CatItem.canView()` under impersonation, and background scripts on
  copies of a producer. The deployed producers' only criterion was *Not available for: SNC
  External*, created by admin in the same second as each item; a customer admin got HTTP 400
  (*security constraints prevent access*) for both. A new item got the row in its insert's own
  transaction, also with `setWorkflow(false)` and also when an *Available for* row naming its sys_id
  was inserted first; no business rule or `glide.sc.*` property adds it. Deleting it with no other
  criterion brought it back at once; with an *Available for* row it stayed deleted, through updates
  of the item. With both rows, the customer admin, a site contact, an agent and a plain internal user
  were all refused. With *Available for* one criterion of the roles asset manager, account manager,
  NOC, customer admin and `sn_customerservice_agent` and *SNC External* deleted: customer admin and
  agent HTTP 200, site contact and a user with `snc_internal` only HTTP 400. Through
  `GlideUpdateManager2.loadXML`, a DELETE naming the row's keys under a new sys_id left it, one
  naming its sys_id deleted it. From `x_daas_ham` the delete was refused by the table's cross-scope
  access policy. ServiceNow KB1383355: `sys_user_role` records coalesce on name, so a role's sys_id
  differs between instances, and a list field of role sys_ids that do not resolve grants nothing.
  The test records were deleted afterwards.
- N50: development instance, 2026-11-12 and 13, the Table and Stats APIs as one test user per
  provider role (its role and `snc_internal`), the ACL records read as admin. Every reference a
  workspace list column, search, filter or group-by reaches, read with `sysparm_limit=1` as each
  role: `customer_account` 403 for all six staff roles and the app admin; `core_company`, `cmdb_ci`
  and `proc_po` 403 for the NOC, account managers and finance; `sn_customerservice_case` 403 for
  all; `cmn_location`, `sys_user`, `cmdb_model`, `alm_stockroom` read by all. `customer_account`'s
  read ACLs (CRM Base Entities) name `csm_ws_integration`, `sn_crm_account_viewer`,
  `sn_customerservice.customer_data_viewer`, `sn_customerservice_agent`, `contact_manager`,
  `customer` and a granular role; `customer_account.name` the same roles; its two Deny-Unless ACLs
  pass every signed-in user. The platform's `asset` contains `contract_manager`, `cmdb_read`,
  `procurement_user`, `inventory_user` and `model_manager`. An Agreement read as finance or an
  account manager came back with no field at all; as an asset manager with every field. An
  app-scoped Allow-If read ACL on `customer_account` for finance gave the group-by its display
  value, but the column stayed out and `customer.nameLIKE` was refused until a
  `customer_account.name` ACL was added; `phone`, `street` and `city` stayed out, read directly or
  through `core_company`. An `x_daas_ham_agreement.*` read ACL for finance gave it the app's
  columns, the currency and the Customer, not `number`, `state`, `starts` or `ends`, which an
  `x_daas_ham_agreement.starts` ACL then gave `starts`; the finance-only `*` ACL took the currency,
  the Customer and the app's columns from the asset manager. The service desk read `number`,
  `short_description`, `state`, `starts` and `ends` of an Agreement and nothing else of it. The
  query_range ACLs: `ast_contract.*`, `.starts`, `.vendor`, `.vendor_contract` and `.po_number`
  need `contract_manager`; `*.<field>` ones are public for some 175 common field names. With the
  app's 25 ACLs emulated (19 read, 6 query_range) a sweep of every list's columns, search and sort
  and every widget, for the seven roles, went from 270 refused or blank requests of 3237 to 9 of
  3178: the search of *Open replacement orders* through its case (`sn_customerservice_case`) for
  all, and of *Unbilled fees* through its Billing period for field techs and the NOC. App ACLs the
  build installed on `alm_asset`, `alm_stockroom` and `alm_transfer_order` are in `x_daas_ham`
  scope though `sys_db_object.create_access_controls` is false on each; a background script in
  `x_daas_ham` could not create one (the table's cross-scope access policy refused it). The test records were deleted afterwards.

## Changes needed in the app

One bullet per item with verdict differs or partially. Items that match but carry optional or
recommended hardening are described in the notes of their area.

### Cisco

- **EoX batching (partially).** `domain/oem/sync-adapters.ts`: replace
  `for (const batch of chunks(pids, 20)) {` with `for (const batch of eoxBatches(pids)) {` and add a
  helper that caps both the count and the joined length:
  `function eoxBatches(pids: readonly string[]): string[][] { const out: string[][] = []; let batch: string[] = []; for (const pid of pids) { if (batch.length === 20 || (batch.length > 0 && [...batch, pid].join(',').length > 250)) { out.push(batch); batch = [] } batch.push(pid) } if (batch.length) out.push(batch); return out }`.
  Optional pagination: change the endpoint at `oem/rest-messages.now.ts` from
  `/EOXByProductID/1/${pids}` to `/EOXByProductID/${page}/${pids}`, add a variable
  `{ name: 'page' }`, and in `domain/oem/sync-adapters.ts` request page 1, then repeat while
  `Number(field(json,'PaginationResponseRecord','PageIndex')) < Number(field(json,'PaginationResponseRecord','LastIndex'))`.
  The `domain/oem/adapters.test.ts` expectation of 2 calls for 21 PIDs still holds when the PIDs are
  short.
- **SN2INFO v2 summary fields (differs).** `domain/oem/sync-adapters.ts`: change
  `startDate: isoDate(field(record, 'coverage_start_date')),` to
  `startDate: undefined, // SN2INFO v2 summary has no coverage start date`, and change
  `endDate: isoDate(field(record, 'coverage_end_date')) ?? isoDate(field(record, 'warranty_end_date')),`
  to
  `endDate: isoDate(field(record, 'covered_product_line_end_date')) ?? isoDate(field(record, 'coverage_end_date')) ?? isoDate(field(record, 'warranty_end_date')),`.
  `domain/oem/adapters.test.ts`: rename the fixture key `coverage_end_date: '2027-06-30'` to
  `covered_product_line_end_date: '2027-06-30'`; the expected output stays the same.
- **SN2INFO errors on HTTP 200 (partially; optional, error body shape unverified).** In
  `ciscoCoverage` (`domain/oem/sync-adapters.ts`), after `const json = call(...)`, add
  `if (json !== undefined && !Array.isArray(field(json, 'serial_numbers')) && JSON.stringify(json).includes('EXCEEDED_OUTPUT')) errors.push('coverage_by_serial: EXCEEDED_OUTPUT')`,
  so an `EXCEEDED_OUTPUT` batch stays stale instead of being stamped checked with no coverage.

### Meraki and HPE Mist

- **Meraki claim response (partially).** `domain/oem/claim-adapters.ts`: replace
  `const claimed = new Set(asArray(field(parseJson(response.body), 'serials')).map((s) => text(s).toUpperCase()))`
  and `const done = claimed.size === 0 || claimed.has(t.serial.toUpperCase())` with
  `const returned = field(parseJson(response.body), 'serials')`,
  `const claimed = new Set(asArray(returned).map((s) => text(s).toUpperCase()))` and
  `const done = !Array.isArray(returned) || claimed.has(t.serial.toUpperCase())`. Only a missing
  `serials` field then counts as unknown/done; an explicit `[]` counts as nothing claimed.
- **Meraki base host (partially).** Add a variable `${meraki_host}` to each function endpoint at
  `oem/rest-messages.now.ts` and `:63` (e.g.
  `'https://${meraki_host}/api/v1/organizations/${org_id}/inventory/claim'`), add a string property
  `x_daas_ham.meraki.api_host` defaulting to `api.meraki.com`, and substitute it in
  `platform/rest-messages.ts` with `gs.getProperty` (not `getPropertySecured`). Whether
  RESTMessageV2 substitutes a variable inside the host part needs checking on an instance;
  `rest.setEndpoint()` is the fallback.
- **Mist JSI lifecycle fields (differs).** `domain/oem/sync-adapters.ts`: change
  `.find((i) => field(i, 'eos_time') || field(i, 'eol_time'))` to
  `.find((i) => field(i, 'end_of_sale_time') || field(i, 'eos_time'))`.
  `domain/oem/sync-adapters.ts`: change
  `dates: { endOfSale: isoDate(field(item, 'eos_time')), endOfLife: isoDate(field(item, 'eol_time')) }`
  to
  `dates: { endOfSale: isoDate(field(item, 'end_of_sale_time')), endOfSupport: isoDate(field(item, 'eos_time')) }`.
  Do not map `end_of_service_time` to `endOfLife`. Update the fixture at
  `domain/oem/adapters.test.ts` to
  `{ model: 'AP45', end_of_sale_time: 1782777600, eos_time: 1940544000 }` with the expected
  `dates: { endOfSale: '2026-06-30', endOfSupport: '2031-06-30' }`, and `docs/spec/p2-oem.md` to
  "`end_of_sale_time` -> end of sale, `eos_time` -> end of support".
- **Mist JSI warranty and contract fields (differs).** `domain/oem/sync-adapters.ts`: change
  `const end = isoDate(field(item, 'warranty_end_time')) ?? isoDate(field(item, 'contract_end_time'))`
  to
  `const end = isoDate(field(item, 'warranty_end')) ?? isoDate(field(item, 'contract_end_date'))`.
  `domain/oem/sync-adapters.ts`: change
  `startDate: isoDate(field(item, 'warranty_start_time')) ?? isoDate(field(item, 'contract_start_time'))`
  to
  `startDate: isoDate(field(item, 'warranty_start')) ?? isoDate(field(item, 'contract_start_date'))`.
  `isoDate` already handles `YYYY-MM-DD`. Optional: `covered: !!end` to
  `covered: field(item, 'has_support') === true || !!end`. Update the fixture at
  `domain/oem/adapters.test.ts` to
  `{ serial: 'A1', warranty_type: 'Standard', warranty_start: '2024-01-01', warranty_end: '2028-01-01' }`.
  Product decision, not required by the spec: Cisco coverage prefers the contract end over the
  warranty end (`domain/oem/sync-adapters.ts`); consider `contract_end_date ?? warranty_end` here
  for consistency.
- **Mist claim (partially).** `domain/oem/claim-adapters.ts`: replace
  `if (!isSuccess(response.status)) { outcomes.push(...fail(batch, errorText(response.status, response.body))); continue }`
  / `const json = parseJson(response.body)` with `const json = parseJson(response.body)`,
  `const hasResult = ['added', 'duplicated', 'error'].some((k) => Array.isArray(field(json, k)))`
  and
  `if (!isSuccess(response.status) && !(response.status === 400 && hasResult)) { outcomes.push(...fail(batch, errorText(response.status, response.body))); continue }`.
  For the reason of a refused code use
  `reasons.length === errors.length ? reasons[errors.indexOf(code)] : reasons.join('; ')` (followed
  by `|| 'claim code not accepted'`). Optional: compare codes after stripping separators
  (`c.replace(/[^A-Z0-9]/gi, '').toUpperCase()`), since `magic` has no dashes.
- **Mist API host (differs).** In `oem/rest-messages.now.ts`, change each Mist function endpoint
  from `https://api.mist.com/api/v1/...` to `https://${mist_host}/api/v1/...` and add a variable
  `{ $id: Now.ID['rm_mist_host_<m|s|claim>'], name: 'mist_host' }` to each function; line 105 can
  stay as the documentation default. Add a string property `x_daas_ham.mist.api_host` (default
  `api.mist.com`, with the 12 documented hosts as choices) and substitute it in
  `platform/rest-messages.ts` with `gs.getProperty('x_daas_ham.mist.api_host', 'api.mist.com')`
  through a non-secret mapping next to the `secrets` of `VARIABLES` (`platform/rest-messages.ts`). Confirm on an
  instance that RESTMessageV2 substitutes `${}` in the host part (fallback `rest.setEndpoint()`).
  With a single host property all configured Mist orgs must be on the same cloud; otherwise store
  the host per org.

### HPE GreenLake and Fortinet

- **GreenLake add devices (differs).** `domain/oem/claim-adapters.ts`:
  `const GREENLAKE_ADD_BATCH = 25` to `const GREENLAKE_ADD_BATCH = 5` (the route's `perCall`
  follows). `domain/oem/claim-adapters.ts`: change
  `JSON.stringify({ network: batch.map((t) => ({ serialNumber: t.serial, macAddress: t.mac })) })`
  to
  `JSON.stringify({ network: batch.map((t) => ({ serialNumber: t.serial, macAddress: t.mac })), compute: [], storage: [] })`.
  Update the comment at `domain/oem/claim-adapters.ts` and the `domain/oem/claims.test.ts`
  expectation.
- **GreenLake async operations (partially).** Option A: add `headers?: Record<string,string>` to
  `HttpResponse` (`domain/http.ts`), fill it in `platform/rest-messages.ts` from
  `response.getAllHeaders()`, add a REST function `async_status`
  (`GET https://global.api.greenlake.hpe.com/devices/v1/async-operations/${op_id}`), and mark done
  only on status `SUCCEEDED`. Option B (smaller): in `greenLakeSubscribe`
  (`domain/oem/claim-adapters.ts`), treat
  `asArray(field(item, 'subscription')).some((s) => text(field(s, 'id')) === t.account)` from the
  `find_device` result as done without PATCHing, so a re-run confirms the assignment.
- **GreenLake assign subscription Content-Type (differs).** `oem/rest-messages.now.ts`: add to
  `assign_subscription`
  `headers: [{ $id: Now.ID['rm_greenlake_patch_ct'], name: 'Content-Type', value: 'application/merge-patch+json' }],`
  and regenerate `src/fluent/generated/keys.ts`. The account value must be the subscription's UUID
  `id`, not its key.
- **FortiCloud products/list response (partially).** `domain/oem/sync-adapters.ts`: change
  `contractNumber: text(field(asset, 'contractNumber')),` to
  `contractNumber: text(field(asArray(field(asset, 'contracts'))[0], 'contractNumber')),` (or pick
  the contract whose `terms[].endDate` equals `latest.end`). After `domain/oem/sync-adapters.ts` add
  ``if (json !== undefined && Number(field(json, 'status') ?? 0) !== 0) {
  errors.push(`products_list ${serial}: ${text(field(json, 'message')) || text(field(json, 'error'))}`);
  continue }``.
- **FortiCloud rate limits (differs).** `platform/oem-sync.ts`: change
  `const assets = staleAssets(vendor, staleBefore.getValue(), 200)` to
  `const assets = staleAssets(vendor, staleBefore.getValue(), vendor === 'fortinet' ? 90 : 200)` and,
  after processing a Fortinet batch, add `if (vendor === 'fortinet') break` (one batch of at most 90
  calls per run). Alternative: replace per-serial calls with paged `products/list`
  `{expireBefore: <far future>, pageNumber}` bulk listing.
- **FortiCloud OAuth (partially).** Test a ServiceNow ROPC OAuth profile on an instance. If it fails
  (ServiceNow requires a Client Secret, which Fortinet does not issue, and Fortinet documents only a
  JSON token body), add a token REST function
  (`POST https://customerapiauth.fortinet.com/api/v1/oauth/token/` with JSON content) and pass
  `Authorization: Bearer ${access_token}` as a function header variable, as the Meraki and Mist
  messages do. Optional comment at `oem/rest-messages.now.ts`: "grant_type=password (Resource owner
  password credentials), token URL https://customerapiauth.fortinet.com/api/v1/oauth/token/
  (trailing slash)".
- **FortiZTP error body (partially).** `domain/http.ts`: change `... || text(field(json, 'detail'))`
  to
  `... || text(field(json, 'detail')) || text(field(json, 'error_description')) || text(field(json, 'error'))`.

### Check Point Zero Touch, ShipEngine and EasyPost

- **Zero Touch base URL and path (differs).** `oem/rest-messages.now.ts`: endpoint
  `https://zerotouch.checkpoint.com/api/v1` to
  `https://zerotouch.checkpoint.com/ZeroTouch/web_api/v2`. Replace function `assign_gateway`
  (`:209-215`) with: (1) `login`: `POST .../ZeroTouch/web_api/v2/login`, content
  `'{"api-client-id":"${api_client_id}","api-key":"${api_key}"}'`, variables `api_client_id` and
  `api_key`, no auth header; (2) `claim_gateway`: `POST .../web_api/v2/claim-gateway`, header
  `{name:'X-chkp-sid', value:'${sid}'}`, variable `sid`; (3) optionally `claim_gaia_gateway`:
  `POST .../web_api/v2/claim-gaia-gateway`, same header; (4) `logout`: `POST .../web_api/v2/logout`,
  header `X-chkp-sid: ${sid}`, no body. The Fluent RestMessage function type has `content?: string`
  (`node_modules/@servicenow/sdk-core/dist/rest/RestMessage.d.ts:90`); send `login` without
  `request.body` so the content template, with the secrets substituted, is the body. Delete the
  comment at `oem/rest-messages.now.ts`.
- **Zero Touch authentication (differs).** `platform/rest-messages.ts`: change
  `[{ variable: 'api_key', property: 'x_daas_ham.checkpoint.api_key' }]` to
  `[{ variable: 'api_client_id', property: 'x_daas_ham.checkpoint.api_client_id' }, { variable: 'api_key', property: 'x_daas_ham.checkpoint.api_key' }]`.
  In `oem/logic.now.ts` add a password2 property `x_daas_ham.checkpoint.api_client_id` ("Check Point
  Zero Touch API Client ID") and reword `prop_checkpoint_key`'s description to "Check Point Zero
  Touch API Key (expires after 1-180 days; regenerate in Zero Touch portal > Manage API Key)".
  Remove the `X-API-Key` header (`oem/rest-messages.now.ts`) and send `X-chkp-sid: ${sid}` from the
  login response.
- **Zero Touch claim body (differs).** `domain/oem/claim-adapters.ts`: replace the `perDevice`
  adapter with a session adapter that runs `unusable(targets,'mac')`; returns calls 0 when
  `maxCalls < 3`; calls `login = http({fn:'login', params:{}})` and reads
  `sid = text(field(parseJson(login.body),'sid'))`; if `sid` is empty, fails the usable targets with
  `errorText(login.status, login.body)`; otherwise, while `calls < maxCalls - 1`, parses
  `[accountId, templateId] = t.account.split('/')` (refusing non-numeric values) and calls
  `http({ fn: 'claim_gateway', params: { sid }, body: JSON.stringify({ 'object-name': t.serial, 'account-id': Number(accountId), 'template-id': Number(templateId), mac: t.mac }) })`
  with ``outcome(..., `claimed with Zero Touch template ${templateId}`)``; ends with
  `http({ fn: 'logout', params: { sid } })`, counting login and logout in `calls`.
  `domain/vocabulary.ts`: label "Check Point Zero Touch (template)" to "Check Point Zero Touch (User
  Center account id/template id)". Update `domain/oem/claims.test.ts`. If `CPAP-SG3600`
  (`entry/demo-seed.ts`) is a Gaia appliance, it needs `claim-gaia-gateway`, so pick the command by
  model family.
- **ShipEngine carrier_id (differs).** `domain/shipping.ts`: add `carrierId: string` to
  `LabelInput`. `domain/shipping.ts`: `shipment: { service_code: input.serviceCode,` to
  `shipment: { carrier_id: input.carrierId, service_code: input.serviceCode,`.
  `delivery/logic.now.ts`: add property `x_daas_ham.shipping.carrier_id` (string, value `''`,
  description "ShipEngine carrier account id (se-...) billed for labels"). `domain/properties.ts`:
  add `shippingCarrierId: 'x_daas_ham.shipping.carrier_id'`. `entry/shipping.ts`: pass
  `carrierId: stringProperty(PROPERTY.shippingCarrierId)` to `buyLabel` and refuse with a clear
  error when it is empty. Update `domain/shipping.test.ts`.
- **ShipEngine addresses (partially).** `domain/shipping.ts`: drop empty values instead of
  sending `''` (e.g. `return Object.fromEntries(Object.entries({...}).filter(([, v]) => v !== ''))`).
  `domain/shipping.ts` `buyLabel`: require the from-side phone, e.g.
  `if (!input.from.phone) return { ok: false, error: 'from address missing phone' }`. Consider
  requiring state for US and CA addresses.
- **ShipEngine webhook auth (partially).** `entry/shipping.ts`: change
  `const token = queryParam(request, 'token')` to
  `const token = request.getHeader('x-naas-webhook-token') || queryParam(request, 'token')`
  (`RESTAPIRequest.getHeader` is in
  `node_modules/@servicenow/glide/src/sn_ws_int/RESTAPIRequest.d.ts:12`). Register the ShipEngine
  webhook with `headers: [{ key: 'X-NaaS-Webhook-Token', value: <token> }]` and update the comments
  at `delivery/logic.now.ts` and `shared/rest-api.now.ts`. Keep `?token=` only as a fallback.
  Optionally verify the RSA-SHA256 signature against `request.body.dataString`.
- **EasyPost Event envelope (partially).** `domain/shipping.ts`: after
  `const easyPost = field(body, 'result')`, add ``const kind = text(field(easyPost, 'object')); if
  (kind && kind !== 'Tracker') return { error: `not a tracking update (${kind})` }``. Equivalently,
  require `text(field(body,'description')).startsWith('tracker.')` when `description` is present.
  Existing tests without `object`/`description` still pass.
- **EasyPost tracking_details order (partially).** `domain/shipping.ts`: replace
  `const last = details[details.length - 1]` with a pick of the detail with the greatest
  `Date.parse(text(field(d,'datetime')))`; datetimes can carry a local offset.
- **EasyPost webhook auth (partially).** Same header fallback as ShipEngine at `entry/shipping.ts`.
  Register the EasyPost webhook with
  `custom_headers: [{ name: 'X-NaaS-Webhook-Token', value: <token> }]` (not `X-EasyPost-*`).
  Optionally verify `X-Hmac-Signature` with `webhook_secret` against `request.body.dataString`.
- **ShipEngine webhook delivery and retries (differs).** `entry/shipping.ts` `postTrackingUpdate`: when
  the Shipment's tracking lock stays held, answer 2xx at once and apply the update in the background
  (an event whose script action takes the same lock and queues itself again a minute later, a bounded
  number of times), keeping 503 only for an update that cannot be queued. Applied on 2026-11-07: HTTP
  202 and the event `x_daas_ham.shipment.track`.

### ServiceNow platform

- **Substatus choices shipped (differs).** Both changes are needed: (1) `now.config.json`: add
  `"legacyChoices": false`; (2) `fleet/tables.now.ts`: add one parent record
  `Record({ $id: Now.ID['substatus_choice_set'], table: 'sys_choice_set', data: { name: 'alm_asset', element: 'substatus' } })`.
  A scratch build with both changes produced one
  `author_elective_update/sys_choice_alm_asset_substatus.xml` with a `sys_choice_v2 version="4"`
  wrapper, all 12 choices, and a `delete_multiple` that only matches those 12 (name, element, value,
  language, dependent_value) identities. Do not add the parent while `legacyChoices` is true: the v3
  output would wipe the out-of-box substatus choices. Requires Brazil, Australia P4+ or Zurich P11+.
  Then add a check that the built XML contains the substatus of every `STAGE_FIELDS` entry with a `choice`.
- **Substatus collisions (differs).** On the instance, query `sys_choice`
  `name=alm_asset^element=substatus^dependent_value=6`. If the out-of-box value is
  `pending_evaluation`, delete the `choice` of `STAGE_FIELDS.pending_evaluation` (`domain/vocabulary.ts`) and its Record
  (`fleet/tables.now.ts`); the substatus mapping can stay. If the value differs, set
  `STAGE_FIELDS.pending_evaluation.substatus` (`domain/vocabulary.ts`) to it and drop the added
  choice. Optional: map `returned_to_lessor` (`domain/vocabulary.ts`) to the out-of-box "Lease
  return" value once that value is confirmed. **Done (Brazil instance, 2026-11-09):** `sys_choice`
  holds `pending_evaluation` (In stock, 6) and `lease_return` (Retired, 7), so the app no longer
  ships either choice; `STAGE_FIELDS` maps the `pending_evaluation` stage to the first and
  `returned_to_lessor` to the second.
- **Out-of-box substatus values (partially).** No code change proposed; confirm the stored values
  other than `available` on an instance.
- **`alm_asset.cost` currency (partially).** Only needed if the session currency can differ from the
  billing currency. `platform/leases.ts`: `asset.setValue('cost', share)` to
  ``asset.setValue('cost', `${currencyCode};${share}`)`` using the lease's currency.
  `platform/margin.ts`: `purchaseCost: num(asset, 'cost')` to
  `purchaseCost: Number(asset.getElement('cost').getReferenceValue()) || 0`, or `getCurrencyValue()`
  with `getCurrencyCode()`.
- **`proc_po` (partially).** `platform/procurement.ts`: replace
  `if (input.shipToStockroomId) po.setValue('ship_to', ...)` with an early
  `if (!input.shipToStockroomId) { gs.warn('[x_daas_ham] No staging stockroom: purchase not requested'); return '' }`
  followed by an unconditional `setValue`. Confirm the column names (`status`, `ship_to`,
  `short_description`) and the `requested` value on the instance.
- **`proc_po_item` open quantity (partially).** `platform/procurement.ts`: add
  `item.addQuery('status', 'NOT IN', 'received,canceled,cancelled')` beside the
  `purchase_order.status` filter, so a line canceled on its own under an open PO no longer counts as
  open. Confirm the stored choice values on the instance.
- **`wm_order` fields (partially).** No code change proposed; confirm the column names behind
  "Scheduled start" and "Estimated end" on an instance.
- **`cmdb_ci.discovery_source` (partially).** No code change proposed; confirm that ServiceNow
  Discovery writes `ServiceNow` on an instance.
- **Refusing a save, or skipping the rules, on a global table (differs).** From `x_daas_ham` the
  platform ignores `current.setAbortAction` and `setWorkflow` on a table of another scope (N35). A
  before rule on such a table refuses with its Abort action: its check is the condition and its
  script only adds the message; the platform runs a condition whatever the filter (N36), so the
  condition starts with the change test that keeps the module unloaded on other saves. **Done** for
  the rack placement rule (`racks/racks.now.ts`, `entry/racks.ts` refusesRackPlacement),
  `NaaS - enforce asset lifecycle` (`alm_hardware`, `entry/assets.ts` refusesLifecycleChange; the
  wipe evidence a save into staging voids is cleared by a rule of its own, `entry/assets.ts`
  clearVoidedWipeEvidence) and `NaaS - work inside the change window` (`wm_order`,
  `entry/delivery.ts` refusesWorkWindow). No other rule refuses a save on another scope's table: the
  before rule on `sn_customerservice_case` (`platform/breakfix.ts` takeFailedAssetTerms) and the
  lease rule and transfer release rule on `alm_hardware` (`platform/leases.ts` giveToLessor,
  `platform/transfers.ts` takeBackStageAfterTransfer) only set fields, and the rest that refuse run
  on `x_daas_ham_*` tables, where `setAbortAction` works (`built-metadata.test.ts` keeps it that
  way). With the lifecycle rule's refusal holding, it also checks the Asset saves Inventory's
  transfer order logic makes for an inventory tech working a line (N38); the next item models them.
  The reads ADR 0005 runs past the visibility rules on `alm_hardware` no longer call `setWorkflow`:
  each marks its GlideRecord while its query runs (`platform/beyond-visibility.ts`) and the app's
  before-query rules leave a marked record's query as it is (N37). **Done** for `platform/racks.ts`
  slotsIn, `platform/asset-identifiers.ts` findAssetByIdentifier (`beyondVisibility`) and
  findAnyAssetBySerial (a receipt's look-up and the serial check of an ASN row),
  `platform/records.ts` findById with `beyondVisibility` (the sighting's and the receipt's fresh
  read), `platform/fulfilment.ts` assetStages, `platform/service-intervals.ts` inServiceNow,
  `platform/delivery.ts` shippable and Ship's re-read, `platform/subscriptions.ts`
  endSitePackageIfEmpty, `platform/session.ts`, `platform/staging-tasks.ts`, `platform/tags.ts` and
  the survivor check of `platform/records.ts` deleteWhere. The mark skips only the app's rules: on
  `alm_asset`, Customer Service's and the platform's query rules still run, for users with Customer
  Service roles, which the app does not grant. `platform/approvals.ts` isActiveUser reads
  `sys_user`, where the app has no rule and the platform's *user query* rule only hides inactive
  users, which it asks for anyway. No app logic saves a record of another scope's table with the
  rules off: each read above that is saved runs every rule on the save, as it did when
  `setWorkflow(true)` came before it.
- **Out-of-box transfer order line logic and the Asset (differs).** The lifecycle rule refused, for
  an inventory tech, the combinations Inventory sets on a line's Asset (N38), and Inventory takes
  onto a line only an Asset *In stock / Available* (N39), which the reserved units sourcing
  transfers are not. **Done** (owner decision, 2026-11-09; ADR 0002): both combinations are one
  stage, *In transfer* (`domain/lifecycle.ts`), which an Asset enters only while `active_to` is set
  and leaves only once it is cleared (`entry/assets.ts` refusesLifecycleChange,
  `platform/transfers.ts` onTransferOrderLine). A before rule ahead of the lifecycle rule gives an
  Asset Inventory lets go the stage it left, in the stockroom Inventory set (`platform/transfers.ts`
  takeBackStageAfterTransfer, `domain/lifecycle.ts` stageAfterTransfer). Sourcing hands each reserved unit
  over *In stock / Available* just before it inserts the unit's line (`platform/transfers.ts`
  requestTransfer), and a unit whose line is cancelled or deleted short of the staging centre is put
  back as free stock and its Order sourced again (`platform/sourcing.ts` putBackUntransferred).

## Still needs an instance or vendor login

Items with verdict unverifiable:

- **Cisco rate limits and quotas.** Per-app quotas are visible only after logging in to the Cisco API
  Console.
- **Meraki coverage via SN2INFO.** No primary source confirms that Meraki devices are in the SN2INFO
  install base or contract data.
- **FortiCloud products/register request schema.** Only on FNDN (login). The per-unit `description`
  field is unconfirmed. If the API user is Org-scoped, add `accountId` at
  `domain/oem/claim-adapters.ts`:
  `JSON.stringify({ accountId: Number(<provider FortiCloud account id property>), registrationUnits: ... })`.
  Check the schema on FNDN before enabling.
- **FortiZTP provision.** Only on FNDN (login). Suggested change, to confirm there first:
  `oem/rest-messages.now.ts` `https://fortiztp.forticloud.com/public/api/v1` to
  `https://fortiztp.forticloud.com/public/api/v2`; `oem/rest-messages.now.ts`
  `.../public/api/v1/devices/${serial}` to
  `https://fortiztp.forticloud.com/public/api/v2/devices/${serial}`; `domain/oem/claim-adapters.ts`
  body to
  `{ deviceSN: t.serial, deviceType: 'FortiGate', provisionStatus: 'provisioned', provisionTarget: 'FortiManager', fortiManagerOid: Number(t.account) }`,
  settling a non-integer account as failed ("FortiManager OID must be a number"); change the
  `domain/oem/claims.test.ts` fixture account `FMG-1` to a numeric OID.
- **FortiZTP client_id.** Read it from the API user's credentials ZIP (normally `fortiztp` per the
  third-party SDKs).
- **`wm_order` state 3 = Closed Complete.** Only community posts give the number.
- **`GlideAggregate.groupBy` on date fields.** The format of a grouped `glide_date` key is not
  documented.
- Transfer orders: Inventory's rules were read on the instance, not run with the app installed (N38,
  N39). Working a transfer order sourcing raised through its tasks as an inventory tech, and
  cancelling one, are checked in [verify-on-instance.md](../verify-on-instance.md#transfer-orders).
- Cisco: how Cisco's path parsing handles PIDs containing `/` (e.g. `CISCO2901/K9`), which
  `platform/rest-messages.ts` sends as `%2F`; some servers reject encoded slashes.
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
