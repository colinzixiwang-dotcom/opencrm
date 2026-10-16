# Udesk ticket center: implementation and operating guide

Status: implemented, 2026-10-16. Udesk is read-only. CRM synchronizes authorized source pages on demand, not the entire ticket history. The live tenant account directory has been synchronized; the existing and imported CRM passwords were reset once to `HarborDemo!2026` at the user's request. Source-disabled accounts remain disabled. No Udesk writes have been made.

Implementation: `backend/internal/integrations/udesk`, `backend/internal/tickets`, `backend/internal/httpapi/tickets.go`, and `frontend/src/tickets.jsx`.

Sources:
- [CRM design, revision 443](https://zuvi.sg.larksuite.com/docx/VAdIduVsioO8m7xGpE1ljIUogwd)
- [Udesk ticket API](https://www.udesk.cn/doc/apiv2/tickets/)
- [Udesk authentication and limits](https://www.udesk.cn/doc/apiv2/intro/)

## Ownership and workflow

Udesk owns ticket fields, assignment, statuses, communications and attachments. CRM owns intake drafts, RMA, eligibility, solutions, tasks and approval/execution state. A resolved Udesk ticket does not complete an RMA, and an RMA update must not silently change the ticket status.

The design requires lookup by ticket number, timestamped snapshots, duplicate checks across ticket/order/SN, and drafts when external queries fail. A synchronized searchable ticket center is an additional projection around that flow. Importing a ticket must never create an RMA or execute a task.

The ticket center displays only Udesk records. Legacy internal tickets remain in the historical business state but are excluded from bootstrap, ticket display and ticket export. Imported records must not use the current local `ticket.transition` or local notes API. Initial integration is read-only; replies and ticket editing remain in Udesk. Later RMA summary writes require one designated writer and an idempotent Outbox keyed by RMA and field version.

## Frontend

- Keep `service` as the stable route/permission key; display Ticket center / 工单中心.
- Server-paginated list: ticket number, subject, customer, assigned agent/group, template, status, priority, channel, tags, created/updated time, linked RMAs, last synchronization. Filters are the actual saved filters returned by Udesk, with source names and IDs; CRM does not invent an unsupported free-form source query. Administrators can maintain status, assignee, date or custom-field conditions in Udesk filters. A separate number lookup retrieves a single source ticket.
- Detail view: original ticket fields; conversation with internal/external distinction; attachments; template/custom fields; related tickets; linked RMAs; synchronization freshness/error. Fetch replies separately with pagination.
- Render custom fields by source field identifier and metadata, preserving nulls, arrays, option IDs and attachment structures. Source-defined titles and option labels remain authoritative; use source bilingual labels when available and fall back to original values. UI chrome remains bilingual.
- Actions: refresh this ticket, open in Udesk, create/resume/save an RMA draft, and display linked RMA IDs. Page export fetches the current authorized source page. Account synchronization and scope configuration are administrator-only. Source errors are explicit and include the last successful list synchronization time; stale rows are not presented as current.
- Creating an RMA prefills the ticket reference and candidate customer/order/SN data, marks source and timestamp, warns about existing links for the same ticket, and leaves product/platform/qualification facts for the operator to complete. Broader automatic order/SN conflict resolution remains future integration work. Udesk's `platform` is a communication channel (email/wechat/etc.), not the RMA purchase platform (Shopify/Amazon/etc.). Do not map them directly.
- External rich text must be sanitized or rendered as plain text. Attachment access must respect authorization; preserve metadata and refresh expired links when needed. Do not automatically download every attachment during import.

## Backend and storage

Implemented `internal/integrations/udesk` for the signed HTTP client and external DTOs, and `internal/tickets` for authorization, query, snapshots and synchronization. Translate external DTOs at the boundary; RMA domain code consumes a small ticket reference/snapshot contract rather than the raw Udesk object.

Do not append bulk Udesk tickets to the existing JSON `app_state`. Every action rewrites that state and bootstrap sends the collection to the browser. The implementation uses dedicated indexed tables and list/detail endpoints. These tables can begin in SQLite and move to the design's PostgreSQL target later:

| Implemented table | Purpose |
| --- | --- |
| tickets | Unique tenant/source ID; indexed identity and assignment, complete source JSON, source update time and fetched time |
| metadata | Tenant/kind records for source statuses, templates, all custom fields/options, filters, sanitized agents, groups and roles |
| mappings | CRM user ↔ Udesk agent, source groups/role/status, own or explicitly authorized group scope |
| snapshots | Immutable timestamped ticket facts referenced by drafts and RMAs |
| drafts | Owner-scoped persisted intake payload and snapshot reference, submitted RMA reference |
| links | Stable Udesk ticket ↔ RMA linkage, created in the RMA/task transaction |
| reply_pages | Source reply pages with content, authors, internal/external visibility and attachment metadata |
| runs | Per-request synchronization status and privileged mapping changes |


Preserve all source fields in raw JSON while projecting important fields into indexed columns. Detail and list responses can expose original snake_case fields in a source object and CRM metadata in a separate object. Raw storage must not bypass field masking or row permissions. Do not force Udesk `solving`/`closed` and custom substatuses into the current `open/in_progress/resolved` enum.

Implemented CRM endpoints:
- `GET /api/tickets` and `GET /api/tickets/:id`: paginated authorized local projection.
- `GET /api/tickets/:id/replies`: authorized paginated conversation.
- `GET /api/tickets/lookup?number=...`: fetch one number, authorize the result before returning/persisting it to the caller's scope.
- `GET /api/tickets/:id`: authorized targeted refresh.
- `GET /api/integrations/udesk/runs/:id`: owner/admin synchronization status.
- `GET /api/integrations/udesk/accounts`, `POST /api/integrations/udesk/accounts/sync`, `POST /api/integrations/udesk/accounts/configure`: administrator account/scope management.
- `POST /api/tickets/:id/drafts`, `GET /api/intake-drafts`, `GET /api/intake-drafts/:id`: create/save/list/resume owned RMA drafts.
- `GET /api/export/tickets?filterId=...&cursor=...`: live authorized-page CSV, including original source JSON.
- Intake draft endpoints link a ticket snapshot and feed the existing server-side warranty/Solution assessment.

One-line agents see their mapped Udesk tickets only, per the design. Team scope needs an explicit grant; possession of the integration admin token does not grant local users global ticket access. Apply this to list, detail, replies, lookup, exports and RMA links. Customer contact fields are masked according to role.

## API details and synchronization

- The API documentation is under `apiv2`, but request examples use `https://<tenant>.udesk.cn/open_api_v1/`. The verified tenant is `https://ticketmorpho.udeskglobal.com/`.
- Backend-only credentials: `UDESK_ADMIN_EMAIL`, `UDESK_OPEN_API_TOKEN`, `UDESK_BASE_URL`. Backend startup now loads `.env` without overriding process environment variables. Never put credentials in `VITE_*`, browser payloads or signed-URL logs.
- Sign each request with email, token, Unix timestamp, unique nonce and `sign_version=v2`; documented SHA256 construction. Verify tenant compatibility before changing algorithms. Check business `code == 1000`, not only HTTP 200. Generate new nonce/signature on every retry.
- Ticket lookup: `GET /tickets/detail` accepts exactly one of `id` or `num`; `#848` must be URL encoded. Keep external ID separate from `field_num`.
- `GET /tickets` defaults to 20 items, max 100 per page. The listed parameters do not include an `updated_since` cursor or guarantee stable ordering. Do not invent one or stop a scan after the first old record.
- Replies: `GET /tickets/:id/replies`, separately paginated, max 100 per page. Ticket-list results alone are not the entire conversation or all detail-only fields.
- Load statuses from `/tickets/status`, templates from `/tickets/ticket_templates`, and complete field definitions/options from `/custom_fields?category=ticket`. The live tenant currently returns 30 custom field definitions and 26 fields on its support template. The old custom-field endpoint is marked deprecated. Validate option-label availability and document schema/example differences with real limited samples before finalizing the mapper.
- The intro documents a default limit of 60 calls/minute. The client spaces calls by 1.1 seconds and retries transient HTTP failures with fresh nonces. Use a shared limiter across bulk jobs, interactive requests and retries; reserve capacity for lookup. Add bounded timeouts, retry/backoff and cancellation. Do network I/O outside database transactions.
- Future large filtered backfills can use `/tickets/export`: up to 1000 records per batch, latest `scroll_id` must be used and expires after one minute. Fetch and persist batches promptly; do not fetch all replies before advancing the scroll. On cursor expiry restart the filter scan safely with idempotent upserts.
- Pilot with selected tickets and metadata, then an authorized small filter/date scope. Bulk import runs as a background job with checkpoints, unique keys, source-version checks and per-item errors. An interrupted/partial job must not be presented as fully synchronized.
- For ongoing updates, first verify tenant filter capabilities and event/webhook contracts. If an update-window filter exists, use overlapping windows plus reconciliation. Otherwise use periodic idempotent scans and targeted refreshes. Webhooks, when available, require authentication and Inbox deduplication; verify before relying on them.
- Only advance a high-water mark when its bounded window completes. Never interpret a missing ticket in a partial scan as deletion. Keep immutable RMA evidence separate from latest external state.

## Permissions and source filter context

Ordinary agents see only `assignee_id == mapped agent ID`. Supervisors additionally see tickets whose source group is explicitly granted, including unassigned tickets in that group. Administrators see all source rows. Unmapped or source-disabled identities fail closed. Lists, detail, replies, number lookup, exports and draft access enforce this on the backend. Contact email/phone fields are masked for non-administrators. Existing RMA permissions continue to apply independently.

The verified admin API token cannot sign requests using ordinary agent emails (Udesk returns code 2059). Consequently, Udesk “My”/“Group” contextual filters run in the integration account's context; CRM intersects the results with the caller's permitted scope and discloses this in the UI. Prefer explicit assignee/group conditions in source-maintained filters where precise per-agent behavior is required. Never treat a source filter as an authorization grant.

CRM cursor pagination rescans the relevant live source page, collects only authorized rows and caps each request at three source pages. Sparse scopes may require continuing to the next cursor. It does not expose global source totals to ordinary agents. As source lists have no documented stable cursor, tickets may move between pages when Udesk updates them.

## Draft evidence and submission

Initial draft creation and subsequent saves refresh the source ticket and preserve a new immutable snapshot. Concurrent or already-submitted draft saves are rejected. Submitting rechecks current source ownership, then links the selected snapshot and closes the draft in the same database transaction as the RMA and tasks. Qualification failure rolls back all creation/link changes. The source ticket number cannot be changed in a linked draft. Existing RMA idempotency receipts remain authoritative on retry.

This release warns about same-ticket RMA links, reads communication without providing a reply editor, and redirects editing to Udesk. It does not implement Udesk writes, full historical backfill, webhook workers, Shopify/MES fact verification, or automatic cross-system conflict resolution. Draft saves currently require a successful source refresh; offline draft saves are future work.

## Validation

Run `npm run test:udesk` for a temporary-database, signed mock integration browser test, and `npm test` for source client, scope, account status, default password, snapshot and atomic submission tests. `npm run test:browser` covers the current 13 visible modules, RMA, audit, warranty, bilingual, proxy login and Udesk integration. The old ERP browser flows for the seven hidden modules are preserved in `tests/legacy-erp-e2e.mjs` for when those modules reopen; current UI tests no longer expect those navigation entries. Test launchers explicitly disable real Udesk credentials unless supplied a mock integration environment.

## Ticket center presentation (2026-10-16)

- Source links use `/entry/ticket/show/{id}`. `field_num` is the human ticket number, never the URL identifier. Numeric IDs are formatted as decimal strings, including IDs above one million; regression coverage includes #717 / 20713607.
- CRM detail links use `#service?ticket={id}` and survive reloads and browser history. Titles and ticket numbers open the same live, permission-checked detail endpoint. Clicking other row space also opens the detail.
- The list shares `ListToolbar`, `SearchControl`, `FilterControl`, and `SortControl` with CRM record tables. Support field filters use the same filter component; local record tables retain sortable column headers and now also provide an explicit sort selector.
- Source saved filters and cursor pagination still request live Udesk data. Search and sort operate on the currently returned authorized page, explicitly labeled as such. Sorting supports updated/created timestamps, ticket number, subject, assignee and status. These controls do not claim to sort or search all source history. Exact ticket-number lookup remains a separate live authorized request.
- Detail renders only populated source/custom fields: nulls, blank strings, empty arrays/objects and dash placeholders are omitted; meaningful `0` and `false` remain. Field headings use source business titles or readable labels, without API-key/type subtitles. Common business fields precede technical identifiers, which remain available in an expandable section. Raw source JSON and immutable intake snapshots retain all fields.
- Content and read-only conversation have a dedicated main column; populated field information occupies a responsive sidebar. HTML is converted to inert text, excluding script/style content. Editing and replies still happen in Udesk. RMA draft creation and all existing permission checks remain unchanged.
- Both `custom_fields` and `custom_fields_v2` are merged for presentation (v1 wins on overlapping keys); v2 is not rendered again as a raw standard field. Long custom values use the full sidebar width. Original source payloads are unchanged.
- At phone widths, each list row becomes a labeled ticket card so titles and customer details remain readable without horizontal table scrolling.

## Shared pagination, conversation layout and previews (2026-10-16)

CRM tables, Udesk lists and conversations now use the shared `Pagination` component. Local tables paginate 20 records, reset the page for searches/status changes, and show their exact page count. Conversations show the source reply page count. Administrators receive ticket totals derived from live Udesk `meta.total_count` and the CRM page size. Scoped actors do not receive a global source count; while their authorized cursor traversal is incomplete, the UI explicitly shows that the total is pending, and shows the actual traversed page total at the end. Entry does not scan/import all history merely to produce a count.

Mail content is converted to inert text with structural paragraph/line boundaries. Source indentation, repeated empty lines and nonbreaking spaces are normalized; message bodies align left, with author/date information in a separate header. Script/style contents remain excluded.

Attachments render as thumbnail cards with a modal preview for images and PDFs, plus native audio/video controls where supported. Unsupported types retain an original-file link. Image failures have an explicit fallback, and pending images use the shared loading state.

Preview bytes use `GET /api/tickets/:id/attachment?ref={origin+path}&replyPage={page}`. The reference contains no OSS signature. The server checks live ticket permission, finds the matching attachment in that ticket or its authorized reply page, and obtains the current signed storage URL. It restricts storage hosts, rejects private network addresses in production, does not forward session/API credentials or follow storage redirects, enforces a 25 MiB limit and checks the media type. Responses use private/no-store caching. Existing page CSP remains unchanged. This also lets previews work on production pages where direct external images are disallowed by CSP.

`LoadingState` supplies shared skeleton layouts for workspace startup, lists, ticket details, fields, conversations and image previews, with reduced-motion support. A failed conversation read shows an error/retry state instead of an endless loader.

PDF previews use a lazily loaded PDF.js worker and canvas renderer with evaluation disabled, rather than an embedded browser PDF plugin. PDF page navigation reuses `Pagination`; responsive canvas sizing fits desktop and phone widths.

## Reading without repeated source content (2026-10-16)

The detail header owns ticket number, subject, status and source channel. The sidebar groups populated fields into customer, handling, order/product and issue classification. Unknown populated fields (including zero/false values) remain in Other fields; identifiers/counters and submission IDs remain in System information. Source custom field titles are retained, with known labels translated through the existing locale dictionary. Initial attachments have a dedicated sidebar section, and reply attachments stay with their messages.

API-channel Problem details render populated Udesk custom fields as a white label/value grid followed by the separate structured problem description. Field names and dropdown values use Udesk definitions; fields shown here are omitted from the sidebar, while submission IDs stay in System information. Missing legacy fields can be recovered from explicit source-label lines; fallback cannot duplicate an already populated field with the same label. When no structured description exists, remaining body text is preserved. Full original submissions remain expandable. Email and other channels display their normal source content without form extraction, issue numbering, contact-suffix heuristics or colored description cards. Source fields and snapshots are unchanged.

A reply identical to the initial body is collapsed only when its author is identified as the same customer and its timestamp is within 60 seconds of creation. Internal notes, unknown identities/timestamps and later identical messages remain visible. The article retains author/date and attachments, plus an expandable original body. Trailing HTML quotes and recognizable text mail headers are expandable; new text after an HTML quote prevents folding. Ambiguous quotations/signatures remain visible. Source records, permission checks, draft payloads and snapshots are not rewritten.


## Conversation chronology (2026-10-16)

Conversation pages read oldest to newest. Udesk supplies newest-first source pages; the backend reads source metadata, maps display page `p` to source page `total_pages - p + 1`, and reverses the selected page. This preserves chronology across pagination, including the partial oldest source page. Raw reply caches retain source page numbers/order. Attachment resolution accepts the display page and uses the same mapping, preserving authorization and previews. No reply body, initial submission or field rendering is changed.

HTML mail now renders through an allowlisted DOM-to-React renderer. Tables retain rows, empty cells and row/column spans, with horizontal scrolling inside the body on small screens. Source scripts, event handlers, inline styles, remote images and unsafe links are excluded. Trailing Gmail/Yahoo/blockquote history is collapsed; new text after a quote keeps it visible. Plain-text messages retain their line breaks. This applies to both the original email and HTML conversation entries.
