# Ticket queue column filters

The queue opens with **My tickets**, **All statuses**, and fixed **last reply descending** order. The toolbar retains search and export. Assignment and status controls live in their column headers; at widths below 700px the two controls stay visible above the existing ticket cards. Empty results retain both controls.

`GET /api/tickets` and `/api/export/tickets` accept `assignment=mine|all` and an exact `status` value. The frontend always requests `sort=repliedAt:desc`. Existing API sort contracts and Udesk saved-filter endpoints remain available for compatibility; the queue no longer offers those controls.

The support application resolves the current CRM user's enabled Udesk agent mapping and applies the selected assignment/status in PostgreSQL **before count, ordering and pagination**, after configured Morpho group membership. The browser never supplies a target agent ID. A missing or disabled mapping yields an empty personal list with an explanation; switching to All tickets is explicit. These presentation filters do not change shared Morpho detail/RMA permissions.

`availableStatuses` contains distinct statuses from the synchronized Morpho projection, so choices do not disappear when searching or selecting a status. Values retain the Udesk status labels, including custom statuses. No new database schema or upstream calls are required for filtering. The existing synchronization freshness policy remains in effect.

## Review environment

Worktree: `/data/zixi_wang/opencrm-ticket-filters`  
Branch: `codex/ticket-column-filters`  
Frontend: `http://192.168.1.61:5186/#service`  
Backend: `http://192.168.1.61:4327/api/health`

This worktree uses the configured PostgreSQL/Udesk integration. It runs on independent ports from the primary environment. Runtime configuration supports `HOST`/`PORT` for Go and `VITE_DEV_HOST`/`VITE_DEV_PORT`/`VITE_API_PROXY_TARGET` for Vite. Browser writes are checked against the configured LAN host and matching Origin.

## Verification

- `./scripts/go.sh test ./...`
- `./scripts/go.sh vet ./...`
- `npm run check`
- `node --test tests/frontend.test.mjs tests/i18n.test.mjs`
- `npm run test:ticket-filters`
- `npm run test:udesk`
- `npm run test:ticket-scope`

The new browser test uses an isolated PostgreSQL namespace and mocked Udesk tickets. It covers default personal scope, global sorting, multiple pages, status intersections, export, non-Morpho exclusion, unmapped accounts, empty-state recovery, and bilingual desktop/mobile presentation. Live screenshots are saved under the ignored `test-results/` directory.
