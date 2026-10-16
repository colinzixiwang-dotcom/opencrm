# Udesk ticket center: proposed implementation

Status: proposal, 2026-10-16. No Udesk tickets have been imported and no Udesk writes have been made.

Sources:
- [CRM design, revision 443](https://zuvi.sg.larksuite.com/docx/VAdIduVsioO8m7xGpE1ljIUogwd)
- [Udesk ticket API](https://www.udesk.cn/doc/apiv2/tickets/)
- [Udesk authentication and limits](https://www.udesk.cn/doc/apiv2/intro/)

## Ownership and workflow

Udesk owns ticket fields, assignment, statuses, communications and attachments. CRM owns intake drafts, RMA, eligibility, solutions, tasks and approval/execution state. A resolved Udesk ticket does not complete an RMA, and an RMA update must not silently change the ticket status.

The design requires lookup by ticket number, timestamped snapshots, duplicate checks across ticket/order/SN, and drafts when external queries fail. A synchronized searchable ticket center is an additional projection around that flow. Importing a ticket must never create an RMA or execute a task.

Keep current demo/internal tickets separate from imported Udesk records. Imported records must not use the current local `ticket.transition` or local notes API. Initial integration is read-only; replies and ticket editing remain in Udesk. Later RMA summary writes require one designated writer and an idempotent Outbox keyed by RMA and field version.

## Frontend

- Keep `service` as the stable route/permission key; display Ticket center / 工单中心.
- Server-paginated list: ticket number, subject, customer, assigned agent/group, template, status, priority, channel, tags, created/updated time, linked RMAs, last synchronization. Filters include own tickets, authorized team tickets, unassigned tickets where permitted, status/substatus, assignee/group, template, channel, date and custom fields.
- Detail view: original ticket fields; conversation with internal/external distinction; attachments; template/custom fields; related tickets; linked RMAs; synchronization freshness/error. Fetch replies separately with pagination.
- Render custom fields by source field identifier and metadata, preserving nulls, arrays, option IDs and attachment structures. Source-defined titles and option labels remain authoritative; use source bilingual labels when available and fall back to original values. UI chrome remains bilingual.
- Actions: refresh this ticket, open in Udesk, create RMA draft, view existing RMA. Bulk synchronization and retry are privileged operations, with visible job progress and failures.
- Creating an RMA prefills the ticket reference and candidate customer/order/SN data, marks source and timestamp, checks duplicates, and asks the operator to resolve conflicting facts. Udesk's `platform` is a communication channel (email/wechat/etc.), not the RMA purchase platform (Shopify/Amazon/etc.). Do not map them directly.
- External rich text must be sanitized or rendered as plain text. Attachment access must respect authorization; preserve metadata and refresh expired links when needed. Do not automatically download every attachment during import.

## Backend and storage

Introduce `internal/integrations/udesk` for the signed HTTP client and external DTOs, and `internal/tickets` for authorization, query, snapshots and synchronization. Translate external DTOs at the boundary; RMA domain code consumes a small ticket reference/snapshot contract rather than the raw Udesk object.

Do not append bulk Udesk tickets to the existing JSON `app_state`. Every action rewrites that state and bootstrap sends the collection to the browser. Use dedicated indexed tables and list/detail endpoints. These tables can begin in SQLite and move to the design's PostgreSQL target later:

| Proposed table | Purpose |
| --- | --- |
| external_tickets | Unique `(provider, tenant, external_id)`; source number, projected searchable fields, source update time, fetched time, latest raw JSON, source hash, completeness |
| external_ticket_snapshots | Timestamped immutable evidence referenced by intake/RMA; refreshes must not alter the evidence used for creation |
| external_ticket_replies | Unique source reply ID, ticket reference, original content/format, author, visibility, attachment metadata |
| external_ticket_templates / fields / statuses | Versioned source definitions, types and option mappings when available |
| external_principal_links | Explicit mapping between local principal and Udesk agent/group IDs; unresolved mappings fail closed |
| ticket_rma_links | Stable ticket identity linked to RMA; display number is not the relational identity |
| integration_sync_runs / items | Mode, filter, cursor/checkpoint, counters, retryable failures, source timestamps and completion status |

Preserve all source fields in raw JSON while projecting important fields into indexed columns. Detail and list responses can expose original snake_case fields in a source object and CRM metadata in a separate object. Raw storage must not bypass field masking or row permissions. Do not force Udesk `solving`/`closed` and custom substatuses into the current `open/in_progress/resolved` enum.

Suggested CRM endpoints (not implemented):
- `GET /api/tickets` and `GET /api/tickets/:id`: paginated authorized local projection.
- `GET /api/tickets/:id/replies`: authorized paginated conversation.
- `POST /api/integrations/udesk/lookup`: fetch one number, authorize the result before returning/persisting it to the caller's scope.
- `POST /api/tickets/:id/refresh`: authorized targeted refresh.
- `POST /api/integrations/udesk/sync-runs` and `GET /api/integrations/udesk/sync-runs/:id`: privileged background jobs/status.
- Intake draft endpoints link a ticket snapshot and feed the existing server-side warranty/Solution assessment.

One-line agents see their mapped Udesk tickets only, per the design. Team scope needs an explicit grant; possession of the integration admin token does not grant local users global ticket access. Apply this to list, detail, replies, lookup, exports and RMA links. Customer contact fields are masked according to role.

## API details and synchronization

- The API documentation is under `apiv2`, but request examples use `https://<tenant>.udesk.cn/open_api_v1/`. A verified tenant base URL is required in addition to the two configured credential variables.
- Backend-only credentials: `UDESK_ADMIN_EMAIL`, `UDESK_OPEN_API_TOKEN`, proposed `UDESK_BASE_URL`. Current startup does not load `.env`; add explicit backend/launcher loading before integration. Never put credentials in `VITE_*`, browser payloads or signed-URL logs.
- Sign each request with email, token, Unix timestamp, unique nonce and `sign_version=v2`; documented SHA256 construction. Verify tenant compatibility before changing algorithms. Check business `code == 1000`, not only HTTP 200. Generate new nonce/signature on every retry.
- Ticket lookup: `GET /tickets/detail` accepts exactly one of `id` or `num`; `#848` must be URL encoded. Keep external ID separate from `field_num`.
- `GET /tickets` defaults to 20 items, max 100 per page. The listed parameters do not include an `updated_since` cursor or guarantee stable ordering. Do not invent one or stop a scan after the first old record.
- Replies: `GET /tickets/:id/replies`, separately paginated, max 100 per page. Ticket-list results alone are not the entire conversation or all detail-only fields.
- Load statuses from `/tickets/status` and templates/field metadata from `/tickets/ticket_templates`. The old custom-field endpoint is marked deprecated. Validate option-label availability and document schema/example differences with real limited samples before finalizing the mapper.
- The intro documents a default limit of 60 calls/minute. Use a shared limiter across bulk jobs, interactive requests and retries; reserve capacity for lookup. Add bounded timeouts, retry/backoff and cancellation. Do network I/O outside database transactions.
- Large filtered backfills can use `/tickets/export`: up to 1000 records per batch, latest `scroll_id` must be used and expires after one minute. Fetch and persist batches promptly; do not fetch all replies before advancing the scroll. On cursor expiry restart the filter scan safely with idempotent upserts.
- Pilot with selected tickets and metadata, then an authorized small filter/date scope. Bulk import runs as a background job with checkpoints, unique keys, source-version checks and per-item errors. An interrupted/partial job must not be presented as fully synchronized.
- For ongoing updates, first verify tenant filter capabilities and event/webhook contracts. If an update-window filter exists, use overlapping windows plus reconciliation. Otherwise use periodic idempotent scans and targeted refreshes. Webhooks, when available, require authentication and Inbox deduplication; verify before relying on them.
- Only advance a high-water mark when its bounded window completes. Never interpret a missing ticket in a partial scan as deletion. Keep immutable RMA evidence separate from latest external state.

## Delivery order and acceptance

1. Verify tenant base URL, backend credential loading, signatures and permissions; read source status/template definitions and a few representative tickets. No full import.
2. Add dedicated storage, identity mapping, source-compatible DTOs and authorized paginated list/detail/conversation views. Mark legacy examples clearly.
3. Connect targeted ticket lookup to intake/RMA drafts, duplicate detection, source provenance and conflict handling. Keep the warranty gate authoritative on the server.
4. Pilot a bounded synchronization job; then expand to authorized historical scope and recurring reconciliation. Add Udesk summary writes only after writer ownership is agreed.

Acceptance covers source-field fidelity, custom field types/options, replies and visibility, bilingual display without rewriting source values, repeat-import idempotency, interrupted jobs, stale updates, authorization isolation, expired cursors, limit handling, and failure without side effects on RMA/tasks.
