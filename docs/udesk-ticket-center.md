# Udesk ticket center: implementation and operating guide

Status: updated 2026-10-19. Udesk is read-only. A shared background worker synchronizes source ranges every minute; interactive lists query PostgreSQL. The shared Morpho membership section below supersedes historical personal-assignment rules. The live tenant account directory has been synchronized; the existing and imported CRM passwords were reset once to `HarborDemo!2026` at the user's request. Source-disabled accounts remain disabled. No Udesk writes have been made.

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
- Server-paginated list: ticket number, subject, customer, assigned agent/group, template, status, priority, channel, tags, created/updated time, linked RMAs, last synchronization. Filters are the actual saved filters returned by Udesk, with source names and IDs; CRM does not invent an unsupported free-form source query. Administrators can maintain status, assignee, date or custom-field conditions in Udesk filters. The shared search input offers an explicit number-lookup action for complete ticket numbers.
- Detail view: original ticket fields; conversation with internal/external distinction; attachments; template/custom fields; related tickets; linked RMAs; synchronization freshness/error. Fetch replies separately with pagination.
- Render custom fields by source field identifier and metadata, preserving nulls, arrays, option IDs and attachment structures. Source-defined titles and option labels remain authoritative; use source bilingual labels when available and fall back to original values. UI chrome remains bilingual.
- Actions: refresh this ticket, open in Udesk, create/resume/save an RMA draft, and display linked RMA IDs. Page export fetches the current authorized source page. Account synchronization and scope configuration are administrator-only. Source errors are explicit and include the last successful list synchronization time; stale rows are not presented as current.
- Creating an RMA prefills the ticket reference and candidate customer/order/SN data, marks source and timestamp, warns about existing links for the same ticket, and leaves product/platform/qualification facts for the operator to complete. Broader automatic order/SN conflict resolution remains future integration work. Udesk's `platform` is a communication channel (email/wechat/etc.), not the RMA purchase platform (Shopify/Amazon/etc.). Do not map them directly.
- External rich text must be sanitized or rendered as plain text. Attachment access must respect authorization; preserve metadata and refresh expired links when needed. Do not automatically download every attachment during import.

## Backend and storage

Implemented `internal/integrations/udesk` for the signed HTTP client and external DTOs, and `internal/tickets` for authorization, query, snapshots and synchronization. Translate external DTOs at the boundary; RMA domain code consumes a small ticket reference/snapshot contract rather than the raw Udesk object.

Do not append bulk Udesk tickets to the existing JSON `app_state`. Every action rewrites that state and bootstrap sends the collection to the browser. The implementation uses dedicated indexed tables and list/detail endpoints. These tables now live in PostgreSQL under Support Access, RMA and Integration ownership. Existing page/reply/cache semantics are preserved:

| Implemented table | Purpose |
| --- | --- |
| tickets | Unique tenant/source ID; indexed identity and assignment, complete source JSON, source update time and fetched time |
| metadata | Tenant/kind records for source statuses, templates, all custom fields/options, filters, sanitized agents, groups and roles |
| mappings | CRM user ↔ Udesk agent identity and source role/group/status; historical scope columns are no longer authorization rules |
| ticket_scopes / ticket_scope_groups / ticket_scope_changes | Versioned product-group membership aggregate, selected group IDs and transactional audit snapshots in Support Access |
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
- `GET /api/integrations/udesk/accounts`, `POST /api/integrations/udesk/accounts/sync`: administrator identity directory management. The old `/accounts/configure` scope editor returns 410 to administrators, 403 to other users.
- `POST /api/tickets/:id/drafts`, `GET /api/intake-drafts`, `GET /api/intake-drafts/:id`: create/save/list/resume owned RMA drafts.
- `GET /api/export/tickets?filterId=...&cursor=...`: live authorized-page CSV, including original source JSON.
- Intake draft endpoints link a ticket snapshot and feed the existing server-side warranty/Solution assessment.

All active CRM users share the configured Morpho group scope, including users without Udesk mappings or assigned roles. Administrators obey the same product boundary. Customer contact masking and owner-based RMA/draft visibility remain as before; ticket sharing does not grant approval, execution or settings permissions.

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

All active users see the same configured Morpho groups regardless of assignment, role or Udesk mapping. A disabled CRM user cannot use their session. Product membership applies to list, detail, replies, number lookup, exports and draft access on the backend. Contact email/phone masking remains role-based; approval/execution and owner-scoped RMA access remain separate.

The verified admin API token cannot sign requests using ordinary agent emails (Udesk returns code 2059). Consequently, Udesk “My”/“Group” contextual filters run in the integration account's context; CRM intersects the results with the configured Morpho group scope and discloses this in the UI. Source filters only narrow the shared Morpho result set; they never grant access to excluded product groups.

CRM pagination queries the published PostgreSQL index. Group filtering precedes count, sort and pagination, so every role receives the same Morpho totals. Index publications and group configuration changes can move rows between pages.

## Draft evidence and submission

Initial draft creation and subsequent saves refresh the source ticket and preserve a new immutable snapshot. Concurrent or already-submitted draft saves are rejected. Submitting rechecks current source product membership, then links the selected snapshot and closes the draft in the same database transaction as the RMA and tasks. Qualification failure rolls back all creation/link changes. The source ticket number cannot be changed in a linked draft. Existing RMA idempotency receipts remain authoritative on retry.

This release warns about same-ticket RMA links, reads communication without providing a reply editor, and redirects editing to Udesk. It does not implement Udesk writes, full historical backfill, webhook workers, Shopify/MES fact verification, or automatic cross-system conflict resolution. Draft saves currently require a successful source refresh; offline draft saves are future work.

## Validation

Run `npm run test:udesk` for a temporary-database, signed mock integration browser test, and `npm test` for source client, scope, account status, default password, snapshot and atomic submission tests. `npm run test:browser` covers the current 13 visible modules, RMA, audit, warranty, bilingual, proxy login and Udesk integration. The old ERP browser flows for the seven hidden modules are preserved in `tests/legacy-erp-e2e.mjs` for when those modules reopen; current UI tests no longer expect those navigation entries. Test launchers explicitly disable real Udesk credentials unless supplied a mock integration environment.

## Ticket center presentation (2026-10-16)

- Source links use `/entry/ticket/show/{id}`. `field_num` is the human ticket number, never the URL identifier. Numeric IDs are formatted as decimal strings, including IDs above one million; regression coverage includes #717 / 20713607.
- CRM detail links use `#service?ticket={id}` and survive reloads and browser history. Titles and ticket numbers open the same live, permission-checked detail endpoint. Clicking other row space also opens the detail.
- The list shares `ListToolbar`, `SearchControl`, `FilterControl`, and `SortControl` with CRM record tables. Support field filters use the same filter component; local record tables retain sortable column headers and now also provide an explicit sort selector.
- Source saved filters and pagination request live Udesk data. Sorting now collects all source pages for the selected filter, deduplicates ticket IDs, applies CRM authorization, then sorts before pagination. The default is last reply descending, with missing/invalid dates last; all offered sort choices are global, with deterministic ID tie breaks and timezone-aware date comparison. Totals reflect distinct authorized rows rather than upstream global totals. A failed source page fails the request instead of presenting partial results as globally sorted. Search remains explicitly limited to the returned page. Exact ticket-number lookup remains a separate live authorized request. Since the documented Udesk list endpoint has no sorting parameter, this correctness-first implementation repeats a complete live scan on entry/filter/sort/pagination/refresh; a persisted index plus incremental synchronization is the recommended next step to eliminate that latency. Offset pagination over live results may shift when upstream tickets change between requests; stable result snapshots would address that separately.
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

Opening a ticket detail does not trigger an unused full list scan; returning to the list triggers a new live list request.


## PostgreSQL list index — 2026-10-19 (current behavior)

- Background synchronization starts with the backend, then attempts every minute. A PostgreSQL session advisory lock coordinates instances; an already running cycle is not overlapped. Failed or longer-than-one-minute cycles can increase freshness lag. The worker uses the existing verified paginated Udesk APIs, not an unverified export dependency, and refreshes field/template/filter metadata every 30 minutes.
- List/search/sort/page/count/CSV queries read PG. SQL intersects tenant, published source membership, the current Morpho group template and search before sorting/counting/pagination. Saved group changes take effect on subsequent requests. Details, replies, attachments, number lookup and draft operations still check live source permission.
- Migration v2 adds typed query columns, query indexes, scope state and versioned membership. Legacy opportunistic cache rows alone never imply a complete initialized index. A successful transaction publishes a new scope generation; a failed scan retains the previous generation and timestamp. Rows missing from a later scope are excluded from that scope without deleting source history/RMA snapshots.
- The tenant's observed final-page repeat is handled by exact first-page ID comparison only at the advertised final page. An empty/repeated intermediate page fails the scan. Deduplication produces local authorized counts instead of exposing source total_count. This is a bounded compatibility rule for observed source behavior, not a claim that the upstream API provides snapshot isolation or perfectly correct totals.
- Lists have no manual refresh button or endpoint. Browsers re-read PG every 15 seconds, without triggering upstream synchronization, and display the selected scope's last complete successful time. Initialization shows “工单数据初始化中”. Background failure is explicit; fresh previous results remain available. After 15 minutes without success, lists return no content for all roles, including administrators.
- Search is global within the authorized selected scope and includes ticket number, subject, source description and custom_fields/custom_fields_v2. It excludes conversation history, masked customer contact fields and attachment URLs. Search is parameterized with literal wildcard handling; list and CSV share the same query. Conversation searching would require a separate full reply ingestion feature.
- Default sorting remains replied_at descending, invalid/missing dates last, with deterministic source ID ties. Read-only repeatable-read transactions keep count/page membership consistent for a request. Separate pages can shift between background publications; the cursor is an offset, not a permanent snapshot.
- No Redis, Kafka, webhook registration, source writes, reply prefetch or RMA business-rule changes are introduced. The background scan and live interactive source reads share the existing client's request pacing.

## Compact ticket workbench — 2026-10-19

The page subtitle is “View Morpho tickets and create linked RMAs.” Queue totals and the last successful synchronization time sit in the card heading. Synchronization cadence, the full timestamp and workspace timezone are available through the synchronization disclosure; search coverage and Udesk-filter semantics have contextual help. Redundant read-only badges and repeated pagination timestamps are omitted.

One search box handles indexed content search. A complete numeric query (optionally prefixed with `#`) offers an explicit Open ticket action, which performs live Udesk lookup and permission checking. Typing alone never starts a live ticket lookup. Lookup failures retain the list and appear inline. Search does not include conversation history.

Initialization, no results, unavailable filters and request failures render within the queue card. Empty lists omit pagination; an empty filtered result offers Clear filters. An unavailable filter offers View all tickets. Source synchronization failures retain the last complete dataset where permitted and disclose its age. Scoped stale lists remain paused by the backend. Raw upstream errors are not displayed in these list states. Local draft-opening errors stay in the drafts panel.

Desktop controls use a compact row. On smaller screens, search, filter and sorting each have a separate row, with contextual help in a viewport-bound disclosure. Both languages retain the existing CRM theme.

For UI-only regression checks against a running LAN frontend, use `node tests/ticket-queue-ui.mjs` (`REVIEW_BASE_URL` overrides the LAN default). List and lookup responses are intercepted with synthetic examples; this checks rendering and interactions rather than upstream correctness. Source authorization and persistence remain covered by `npm run test:udesk` with an isolated PostgreSQL namespace and mock Udesk.


## Shared Morpho after-sales group membership — 2026-10-19 (current authority)

The active setting is **售后配置 → 工单售后组归属配置** / Support configuration → Ticket after-sales group membership. Membership matches the ticket's `user_group_id`, independent of its assignee and the viewing user's roles/source groups. Default selected IDs are `4918`, `4974`, `5041`, `5042`, `5043`, `5044`. `5060` (Email-售前组-Colorbox) is not selected. Missing groups are excluded unless Include tickets without a handling group is enabled. Newly discovered group IDs are never automatically included. Source IDs missing from the current directory are shown with their indexed counts; an unknown, unselected ID cannot be added until present in the directory. An existing missing selection can be removed.

The administrator can refresh the source group directory without account synchronization or password changes. Only group IDs and names are exposed. Counts and candidate previews use the last complete global PG index; they do not call Udesk or trigger full scans. The preview is approximate with respect to upstream changes. Saving the template applies immediately to indexed rows without resynchronizing or deleting tickets. An empty selection deliberately produces an empty scope. Defaults are seeded once per source tenant and never reapplied after edits/restarts.

All authenticated, enabled CRM users receive service view, RMA view and RMA creation as baseline capabilities, including users with no roles or mappings. Saved Udesk filters are shared source result sets and remain intersected with product membership. Search/count/export/sort/pagination all apply group membership in SQL before pagination. A list older than 15 minutes is paused for every role. Detail, replies, attachment access, lookup, draft save/resume and RMA submission revalidate live source group membership. An upstream outage cannot grant detail access from cached membership. Transferring between agents within Morpho does not revoke access; moving to an excluded group does. Lists can retain their normal background-sync delay.

RMA eligibility and approvals are unchanged. Own drafts/RMAs and their link visibility remain owner/admin scoped. Sharing source tickets does not grant access to other people's draft payloads, notes, approval or execution actions. Existing RMA/snapshot history is retained when membership changes.

Migration v3 adds `support_access.ticket_scopes`, `ticket_scope_groups`, `ticket_scope_changes`. A configuration save locks its aggregate row, checks the expected revision, replaces its member rows and appends a versioned snapshot/actor/time in one PG transaction. A stale editor receives HTTP 409 and must reload. This is a small group-membership aggregate, not a generic rule engine. Access Control owns login/base capabilities; Support Access owns product membership/source projection; RMA owns intake and case lifecycle; Integration owns background sync.

Administrator endpoints:

- `GET /api/integrations/udesk/ticket-scope`: current template, sanitized group directory and recent change records.
- `POST /api/integrations/udesk/ticket-scope`: save `revision`, `groupIds`, `includeUnassigned`.
- `POST /api/integrations/udesk/ticket-scope/preview`: preview candidate `groupIds` / `includeUnassigned` against the index.
- `POST /api/integrations/udesk/ticket-scope/groups/sync`: fetch every source `user_groups` page, then publish the complete group directory; no source writes.

Run `npm run test:ticket-scope` for the isolated PG/browser regression of configuration, new-group opt-in, unknown-group exclusion, unsaved changes, version conflicts, immediate queries, missing-group opt-in, full shared access and draft revocation.

### Membership settings and audit presentation

The membership form uses a compact group selector, selected count, synced-ticket preview and explicit opt-in for tickets with no source handling group (product unknown; unrelated to assignee). The footer contains one row: View change history, Cancel changes and Save configuration. History is collapsed initially; expanding it shows a table of the latest 20 changes with actor, Beijing timestamp to seconds, added/removed group IDs and the no-group option before/after. Revision and update metadata are omitted from the footer; directory freshness is available on the directory refresh button. Differences are reconstructed from persisted revision snapshots, including one predecessor beyond the displayed window; missing snapshots are identified rather than guessed. Group labels use the current directory; IDs identify groups across renames.

### Conversation readability (2026-10-19)

- Keep chronological replies. Label known source customer/agent identities separately from internal notes; unknown source identities keep the generic external-reply label.
- Conversation timestamps use Asia/Shanghai with an explicit timezone caption. Show the source message count; omit pagination for a single page, retaining existing controls for multiple pages.
- Samsung/Outlook HTML with an Original message separator plus From/Date/To/Subject headers can fold its historical tail while keeping the complete HTML available. Explicit quotes followed by new inline text remain expanded. No-main-body and unrecognized cases are preserved.
- Flatten only explicitly marked mail layout tables with at most one meaningful cell per row and no own headers/merged cells. Ambiguous and data tables retain their structure. Known mail-client signatures are muted, not deleted.
- EML attachments show Original email, file size and Download. Downloads use the existing live-authorized source attachment proxy with `download=1`, attachment disposition and octet-stream content type; EML remains unavailable for inline preview.

Validation: ticket #717 verified against live Udesk detail/replies, original EML download, collapsed/expanded history, Chinese/English and mobile rendering. Ticket #520 currently returns 404 under configured Morpho membership, so its live view was not bypassed; data tables, merged/empty cells, quoted HTML and trailing inline replies were checked with isolated PostgreSQL/browser fixtures.

### Outlook threads and attachment pagination (2026-10-19)

Ticket #562 uses an Outlook `divRplyFwdMsg` header after an in-body policy quotation. Validated Outlook reply headers take precedence over ordinary blockquotes, so the policy quotation and all six new questions remain visible while prior mail is folded. Samsung separator recognition remains covered by #717 and browser fixtures. Safe paragraph spacing and ordered-list start values are preserved; only explicitly identified Outlook file chips are shown separately as external links (including OneDrive), not as downloaded Udesk attachments.

Both the ticket sidebar and each reply show all attachment cards together without list pagination. Pagination is only shown inside the preview dialog, with compact left/right controls and current/total position. The controls reuse the global Pagination component. Sidebar files come from the source ticket detail `attachments`; conversation files come from each reply’s `attachments`. The sidebar is not a CRM-generated union of all reply files, and the two source collections are not deduplicated against each other. Preview dialogs opened from either location support left/right controls and ArrowLeft/ArrowRight, excluding native media/input interactions. Each gallery resets if its source file list or ticket/page changes. Single attachments omit pagination, EML keeps its authorized download, and unknown file URLs remain excluded.

Validated with live #562 Chinese/English desktop/mobile screenshots, all three reply attachments and #717 single-email regression; browser fixtures cover image/failure/PDF/EML transitions, first/last limits, keyboard navigation, Outlook inline quotations/questions, paragraph spacing, and original quoted HTML/data tables.

### CRM source contract / Udesk ACL (2026-10-19)

The application now consumes `internal/supportsource` ports and typed records. Udesk endpoint paths, chronological reply pagination, source field translation and credential-free attachment reference resolution belong to `integrations/udesk`. React requests the CRM v2 contract and no longer reads Udesk DTO keys. Migration 6 adds versioned JSONB projections without removing raw records, historical snapshots or links. See [the ACL architecture and rollout contract](udesk-acl.md) for context ownership, compatibility, failure behavior, schema changes and remaining scaling limits.
