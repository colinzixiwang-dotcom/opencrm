# Order center and year-to-date order index

## Boundaries

| Upstream | Consumer | Contract and responsibility |
| --- | --- | --- |
| Mabang | ACL | Read-only signed order pages and exact lookups; translate identities, cursor behavior, empty voided orders |
| ACL | orderindex | `ordersource.BatchSource`/`Page`; durable query projection and backfill checkpoints, not order lifecycle |
| orderindex | originalorders | Tenant-scoped number references; resolve all matching shop/source identities, then read live source evidence |
| originalorders | RMA | Existing immutable confirmed evidence and warranty gates; no ERP writes |
| access control | HTTP/UI | Four separate grants; all checks run on every request, revocation applies immediately |

Schema v10 adds `order_reference.order_index_records` and
`integration.order_index_jobs`, plus four permission-menu records. It does not
modify existing RMA evidence, tasks, source orders, catalog policies or inventory.
Imported facts are rebuildable. RMA confirmations remain independent snapshots.

## Permission contract

| Permission | Purpose |
| --- | --- |
| `erp:orders:view` | Enter the order-center page / receive its menu entry |
| `erp:orders:list` | Enumerate indexed summaries and total count |
| `erp:orders:search` | Exact platform-number lookup; no empty or wildcard enumeration |
| `erp:orders:detail` | Fetch complete live source details |

The page and every API require view plus at least one of list/search. List,
search and detail then each require their own grant. Thus detail alone never
opens the menu. List and search return summaries only; neither reveals the
customer address or full source fields. A user with search but no list starts
with an empty search prompt, and never automatically fetches the list. Only
administrators receive implicit access; existing role grants are unchanged.
The RMA order-lookup capability remains authorized separately by `rma.create`.

## Backfill

```sh
./scripts/go.sh build -o ../.bin/orderindex ./cmd/orderindex
./.bin/orderindex -from 2026-01-01 -to 2026-10-23
./.bin/orderindex -status
./.bin/orderindex -resume OIDX-2c60aebb2826
```

The current production job is `OIDX-2c60aebb2826`. Scope means orders by
**payment date**, not every record created this year; unpaid records without a
payment date cannot be claimed covered by this query. The current day is a
snapshot at the time of reading, not a guarantee about later orders.

Each day reads both applicable ranges: history normal/abnormal (`canSend=1/2`),
or recent unshipped/non-unshipped (`status=6/7`, `canSend=3`). No status filter
is supplied for history, retaining its documented default statuses 3/4/5.
The job freezes its four-month boundary on creation, starts with the newest day,
and consumes every page. Read-only API calls share the Mabang adapter's
per-process one-request-per-second gate. A separate CLI process has a separate
gate; this is not a distributed rate limiter. No recurring order synchronization
is enabled by this feature.

The recent API documents daytime batch coverage as only seven days and allows
four-month date queries at 19:00–07:00 (Shanghai). Start/resume broad recent
backfills in that window. Rejected queries remain failed/incomplete, not empty.
History supports single paid dates with cursor paging. We observed a terminal
history page returning `hasNext=false` with a nonempty `nextCursor`; the explicit
boolean is authoritative, so that cursor must not be followed. Historical voided
orders can omit items: keep their header, but never invent an RMA item.

Each page atomically upserts records and updates the job checkpoint. A day is
completed only after both branches and all pages succeed. Jobs have tenant
creation locks, worker leases, transient retries and visible failure reasons.
Interrupted workers can be resumed once their five-minute lease expires. A
failed worker releases its lease immediately. Cursor invalidation requires
review/restarting that date; do not mark a partially read day complete.

## Query and detail behavior

- `GET /api/orders?page=1&sort=paid_desc`: SQL sorting/paging, 20 summaries.
- `GET /api/orders/search?number=...`: exact local reference lookup; if absent,
  attempt live recent lookup, retaining distinct shop/order matches. A historical
  number not indexed still requires a saved source number or paid date.
- `GET /api/orders/:id`: retrieve the reference, then read Mabang live and verify
  source number/shop before returning full details. Source failure is an error,
  not a cached response disguised as live.
- `GET /api/orders/status`: recent backfill progress; no customer details.
- `POST /api/orders/backfill`: administrator only, start or resume a range.

The list uses the common search/sort/pagination components and displays a
snapshot projection. It is not a live order-status feed. Details and RMA
lookups read source facts live. Confirmation uses the saved candidate (valid for
30 minutes) and rechecks CRM policy; it does not issue another source request. Searches operate on exact numbers, not on
customer names, addresses or arbitrary full text.

Full non-empty source fields are available in grouped, expandable sections in
order details and RMA original-order results: buyer/address, shipping, money,
items and remaining fields. Known fields use CRM labels; unknown fields retain
source keys. HTML is displayed as text. Source timestamps, amounts, units and
codes are not silently converted into warranty evidence. Zero/false are retained.

## Failure / rollback

| Condition | Behavior |
| --- | --- |
| Timeout, quota, temporary outage | bounded backoff; retain page/day checkpoint and show failure |
| Invalid payload / missing shipped-order items | fail the page; never publish a complete day |
| Missing items on voided historical header | index/display header; no selectable RMA item |
| Same platform number in multiple shops | keep separate references/candidates |
| Detail permission revoked | next HTTP request denied, including guessed URLs |
| Role has view but no list/search | hide sidebar entry and deny direct page/API access |
| Old mapping no longer resolves upstream | show error; never attach a different order |

Stop the index worker and feature service before optional schema rollback.
`docs/migrations/010-order-index-down.sql` removes only the rebuildable index,
job checkpoints and four added permissions; export these tables first if their
recovery/progress evidence is needed. Existing RMA and original-order evidence
are preserved. Reverting source alone may leave these additive tables safely
in place. Review deployments use the shared .84 PostgreSQL database.

## Mapping version 2 and synchronization capability review

See [Mabang normalization and synchronization plan](mabang-order-sync-plan.md)
for the implemented semantic contract, safe reprojection command, verified
updated-time capabilities, and the distinction between proposed jobs and native
API features. Continuous order synchronization remains disabled. The order page
shows the last completed backfill time and automatically updates its local list
when the index revision changes, without a manual refresh button.
