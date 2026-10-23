# Read-only Mabang catalog and ticket RMA intake

## Current scope and integration boundaries

| Upstream / context | Consumer | Contract owner / translation |
| --- | --- | --- |
| Mabang | catalog | `catalogsource` owns neutral Product/Position contracts; Mabang ACL maps stockSku, virtualSku, warehouse quantities |
| catalog | originalorders | Exact SKU or unambiguous virtual SKU identity; `allowOriginal` controls recognition independently of sale status |
| catalog | support | Administrator-owned product type, warranty class and `allowReship`; support rechecks policy during RMA creation |
| originalorders | support | Immutable confirmed order/item evidence; purchased product and replacement lines are separate |
| support | future fulfillment | RMA tasks record needs only; no upstream order creation, shipping or inventory reservation |

Only the four explicitly allowlisted APIs can pass through the Mabang transport:
`order-get-order-list-new`, `get-history-order-list`,
`stock-do-search-sku-list-new`, `stock-get-stock-quantity`.
Credentials and HMAC signatures stay on the backend.

## SKU and inventory synchronization

Admin starts `POST /api/catalog/sync` with `fromDate` (default UI: 2015-01-01).
The backend returns a job immediately. Creation windows are at most 29 days,
Shanghai time, with overlapping boundaries and source-ID deduplication. SKU pages
follow `nextCursor`; inventory is queried in batches of at most 100 exact SKUs
and paged using the returned record count. The tenant returns `data:null` for
empty SKU windows; only that documented-by-observation shape with no next cursor
is treated as empty. Missing/malformed pages and quantities fail the entire job.

A full successful job publishes under the workspace transaction lock. No network
request runs while holding that lock. Failed jobs retain the previous published
catalog and inventory. All imported SKUs start with `allowReship=false`,
`allowOriginal=true`, `productType=general`, `warrantyClass=none`. Thus imported
identity alone cannot pass warranty or fulfillment checks. Source sale status
and fee/test-name hints are advisory, never authorization. Administrators classify
and enable specific device/part SKUs with a required reason and optimistic policy
revision. ERP sync preserves these local decisions. Missing source SKUs are marked
absent and cannot be used for reshipment.

Inventory is a separate snapshot: on hand, available, awaiting shipment,
purchasing, transfers and bin. Warehouse bindings are explicitly not quantities.
No local stock adjustment or reservation is exposed for imported SKUs. Sync is
manual/admin initiated for this iteration, not a new aggressive ERP polling loop.
The covered creation range and last successful synchronization are visible.

The real import on 2026-10-23 returned 104 SKUs: 57 selling, 39 discontinued,
8 automatically created; 256 warehouse positions across 16 warehouses. All 104
remain disabled for reshipment until reviewed. Do not infer completeness before
the configured coverage start date. Fetching many years costs one or more requests
per window: later optimize with a verified incremental cursor/index, not a silent
narrow window that drops old identities.

## Product and inventory UI

- Product sidebar entry: searchable/paginated/sortable ERP catalog, source-state
  and reship filters, images, master SKU and virtual aliases. Long alias lists
  are summarized in the list and fully shown in SKU details.
- SKU details: source metadata and warehouse bindings above local RMA policy;
  administrator changes record actor ID/name, time, reason and field diffs.
- Inventory sidebar entry: read-only warehouse snapshots, warehouse filter,
  shared search/sort/pagination; missing quantities display as unknown.
- Ticket RMA: order confirmation step, then solution/warranty and one to fifty
  distinct replacement lines. Whole-unit and part solutions restrict replacement
  SKU types. Each line becomes an independent task and a permanent SKU/name/qty/
  policy-revision snapshot. Original order evidence is unchanged.
- Order search exposes one platform-number input. Payment-date/shop assistance
  appears only on `history_identifier_required`, not on network/auth errors.
  Known mappings are restricted by supplied shop; ambiguous mappings are never
  silently resolved to the most recently observed ERP number.

## Reversible migration and demo cleanup

Schema v9 adds only `integration.import_batches`; startup performs no ERP calls
and no demo cleanup. Each completed import stores before/after images of products,
stocks, movements, warehouses and the inventory projection in PostgreSQL. Known
starter products are removed only when ID, SKU and name match seed identities;
their stock and movements are removed with them. RMA/commercial history is retained.
User-created products and stocks are preserved. Starter data in isolated test
namespaces remains available to legacy tests. No production seed file replacement.

Rollback the import BEFORE reverting code, using its batch ID:

```sh
./scripts/go.sh build -o ../.bin/catalog ./cmd/catalog
./.bin/catalog -rollback CAT-e024c8d1d399
```

Equivalent authenticated admin API:
`POST /api/catalog/rollback {"batchId":"CAT-e024c8d1d399"}`.

Rollback checks the saved after-image and refuses to overwrite later catalog,
inventory or policy changes. It also refuses when newly imported SKU identities
are referenced by business records or confirmed original orders. Resolve these
references/changes explicitly; do not force overwrite production state. Audit
history remains append-only, including rollback actor and timestamp.

After successful data rollback and stopping the feature service, optional schema
rollback is in `docs/migrations/009-catalog-down.sql`. Export/retain the batch
before-image first if the recovery evidence is still needed. Leaving the additive
table in place is safe with the previous code version.

## Failure and compatibility behavior

| Failure | Behavior / recovery |
| --- | --- |
| timeout, auth rejection, quota | failed job, prior snapshot retained; retry explicitly |
| repeated cursor / missing inventory SKU | refuse partial publication |
| concurrent sync | one running job per tenant; duplicate request returns 409 |
| worker exits | one-hour lease expires; next sync marks interrupted job failed |
| policy changed while editing | expected revision returns 409; reload |
| rollback would overwrite new data | 409; restore selectively after reviewing references |
| old order number differs from ERP number | mapping or payment-date-assisted history search |
| missing delivery/activation/warranty class | incomplete assessment; formal RMA blocked |

Neutral contracts retain current field names; provider additions remain raw
snapshot metadata until explicitly mapped. Existing single-task RMA clients remain
compatible, but imported replacement SKUs still require current catalog permission.
No broadening of Udesk Morpho ticket group policy or live detail authorization.

Review worktree: `/data/zixi_wang/opencrm-mabang-catalog-rma`, branch
`codex/mabang-catalog-rma`; frontend `http://192.168.1.61:5186/`, backend 4327.
It uses the configured .84 PostgreSQL database; Git worktrees do not isolate shared
database state. The main worktree's three pre-existing dirty files are untouched.
