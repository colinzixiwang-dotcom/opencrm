# Ticket-linked original-order confirmation and reship RMA

This intake reads Mabang and creates CRM records only. It has no Mabang creation,
modification, shipment or logistics-tracking commands. An original order is evidence,
never the shipment target for a replacement.

## Boundaries and contracts

| Owner | Responsibility | Consumer |
| --- | --- | --- |
| `ordersource` | Version 1 CRM order/query contract; separate platform number, source number and source ID | Order reference application service |
| `integrations/mabang` | Exact-body HMAC-SHA256 signing, documented parameters, status coverage, bounded cursors, source errors and normalization | `ordersource.Source` |
| `originalorders` / PG `order_reference` | Actor/draft scoped candidates, identifier mappings and immutable confirmation evidence | RMA intake |
| `support` / PG `rma` | Solutions, reason, versioned warranty assessment, evidence provenance and case/task lifecycle | CRM UI |
| `tickets` / PG `support_access` | Live Morpho scope checks and immutable ticket snapshots | Drafts and RMA submission |

The frontend never signs ERP requests or submits an authoritative order snapshot.
The backend resolves `orderConfirmationId`, checks its user/draft, order/platform/item
identity and current catalog SKU mapping, then attaches the saved evidence inside
the same transaction that creates the RMA and ticket link. Ticket scope is checked
against Udesk before submission. Existing unrelated RMA workflows remain supported;
ticket intake accepts only `reship_device` and `parts`.

## Queries and errors

`POST /api/original-orders/lookup` accepts `draftId`, `orderNumber` (the platform trade
number), optional `paidDate` (`YYYY-MM-DD`) and `shop`. The active actor must own an
unsubmitted ticket draft and retain live access to its Morpho ticket.

1. Recent API: `order-get-order-list-new`, exact `salesRecordNumbers`, `status=7`,
   `canSend=3`. If empty, also check `status=6` so an unshipped order is not reported
   as nonexistent. Only shipped/completed originals can subsequently be confirmed.
2. History: `get-history-order-list` using a previously observed Mabang
   `platformOrderId`, or a supplied payment date; query both documented normal and
   abnormal `canSend` values (1/2). Every result must still match
   `salesRecordNumber` exactly. Optional shop is checked as well.
3. Each scan permits at most five pages of 100 results; too broad a scan fails
   explicitly. No unbounded historical scan and no assumption that a platform trade
   number equals the ERP order number. A missing historical identifier/date is 422,
   an exhausted exact search is 404. Errors, timeouts, rate limits, malformed pages
   and zero results are separate outcomes.

All users share a process-wide one-request-at-a-time, one-second-spacing budget.
Each HTTP lookup has a 45-second context; individual calls have a 25-second timeout.
Reads are retried explicitly by the user; no automatic write/retry behavior exists.
The budget is intentionally process-local for today's single Go process; multiple
replicas must coordinate the tenant budget before enabling parallel upstream reads.

`POST /api/original-orders/confirm` accepts `draftId`, `candidateId`, `itemId`.
Candidates expire after 30 minutes. Confirmation makes a new immutable record,
including original source evidence and normalized fields. It never overwrites the
candidate. Historical mappings are tenant scoped. Raw ERP payloads are not sent to
the browser; normalized confirmation UI omits addresses and customer contacts.
No separate full ERP order database is synchronized.

## Product and warranty gates

A purchased item's exact stock SKU (platform SKU fallback when absent) must resolve
to one CRM device SKU. No fuzzy name match or manual override is accepted. Known
ColorBox items are excluded even if accidentally entered in the catalog. Unmapped
items stay visible as candidates but cannot be confirmed. Catalog setup is required
for actual Morpho SKU numbers; test examples are not added to the production catalog.

A ticket RMA requires a confirmed item, a shipped/completed original, an enabled
platform, an enabled reship solution, a solution reason and a manual delivery-evidence
reference. The server re-evaluates the versioned warranty policy at submission.
Only `covered` can create the case. Missing evidence, expired, not-started and
no-warranty-required assessments cannot pass this intake. Payment/shipment dates
are displayed as source facts and are never substituted for delivery/activation.
Manual evidence records source, author ID/name, reference and recording timestamp.

`reship_device` is independent of `replacement` (return and replace). It generates
only outbound device tasks for the original SKU. `parts` requires compatible part
SKUs and positive quantities. Existing task validation checks catalog compatibility.
RMA details retain original-order snapshot, selected original item, ticket snapshot,
solution snapshot/reason, rule revision and evidence provenance.

Migrations 7/8 add the `order_reference.order_evidences` table and seed the independent
solution / TikTok Shop platform without resetting existing configuration or cases.
Both normalized and raw JSON are stored in PostgreSQL. Migration ledger and current
aggregate persistence remain the existing system of record.

## Validation and operational notes

`node tests/mabang-e2e.mjs` uses isolated PG schemas, signed Mabang fixtures and the
existing Udesk fixture. It exercises query/confirmation, ColorBox exclusion, historical
fallback, tampered identities, warranty/reason/part gates, both reship solutions and
RMA detail evidence. `MABANG_TEST_URL` is accepted only when `PG_TEST_NAMESPACE` is set;
production always uses `https://gwapi.mabangerp.com/api/v2`.

A controlled live request for `8821619,577623733901104116` returned both records.
`8821619` maps to Mabang number `8086064201975`; the TikTok trade number equals its
Mabang number. Both are ColorBox, so they demonstrate lookup but cannot validate a
Morpho warranty/RMA. No live historical order was supplied: history handling is
contract/fixture tested, not claimed as tenant end-to-end verified.

Future replacements must receive a new Mabang platformOrderId; shipment commands,
when implemented, must target that new replacement order only. A future mapping
version must preserve existing confirmation snapshots and add contract fixtures
before switching the adapter. No current RMA evidence is rewritten on source change.

## Two-step intake and manual original orders

Ticket RMA entry uses two steps: **Order information** and **Solution and warranty**.
Step 2 remains unavailable until the server returns an original-order confirmation.
Both steps can save a draft. Back/forward retains entered solution inputs; editing an
order invalidates its confirmation and clears the previous solution/warranty inputs.
Only the current step is mounted, so hidden required fields cannot block order entry.
The footer keeps Save draft / Back / Next or Create RMA available while content scrolls.

`POST /api/original-orders/manual` accepts an owned, live-authorized ticket draft,
platform order number, enabled platform, original device product ID, positive whole
quantity, payment date, optional shop, purchase-evidence reference and entry reason.
It stores a new immutable confirmation using `provider=manual`, never Mabang. The
actor name/ID and timestamp are recorded. The record has no ERP ID, ERP number or
verified shipping status; the manual purchase evidence appears in RMA details.
These entries never supply a platform-to-ERP identifier mapping for historical lookup.

Manual entry is an explicit business input path, not an override of catalog matching,
ColorBox exclusion, solution validation or warranty coverage. Warranty evidence is
still provided and evaluated separately in step 2. Imported ERP originals continue
to require shipped/completed source status. No new database table or migration is
needed: the existing order-reference evidence table already owns these snapshots.
